// Anthropic provider — streams Claude API responses as ProviderEvents.

import type { Provider, ProviderEvent, GenerateParams } from './provider.ts'
import { provider as providerUtils } from './provider.ts'
import { appendFile } from 'node:fs/promises'
import { auth } from '../runtime/auth.ts'

async function* generate(params: GenerateParams): AsyncGenerator<ProviderEvent> {
	await auth.refreshAnthropicAuth()
	const { accessToken } = auth.getAuth('anthropic')
	const maxTokens = 16384
	const isAdaptive = /^claude-(opus|sonnet)-4-6/.test(params.model)
	const supportsThinking = /^claude-(opus|sonnet)/.test(params.model)

	const system = [{ type: 'text', text: params.systemPrompt, cache_control: { type: 'ephemeral' } }]

	const body: any = {
		model: params.model, max_tokens: maxTokens, stream: true,
		system, messages: cacheBreakpoints(sanitizeMessagesForAnthropic(params.messages)),
	}
	if (supportsThinking) {
		body.thinking = isAdaptive ? { type: 'adaptive' } : { type: 'enabled', budget_tokens: Math.min(10000, maxTokens - 1) }
	}
	// DEBUG: log outgoing thinking blocks with per-session files
	const _msgs = body.messages as any[]
	const _session = params.sessionId ?? 'unknown'
	const _lines: string[] = [`=== ${new Date().toISOString()} session=${_session} model=${params.model} total=${_msgs.length} ===`]
	for (let mi = 0; mi < _msgs.length; mi++) {
		const msg = _msgs[mi]
		const c = msg.content
		if (!Array.isArray(c)) continue
		for (let ci = 0; ci < c.length; ci++) {
			const block = c[ci]
			if (block.type !== 'thinking') continue
			const sig = block.signature ?? '(none)'
			const thinkLen = (block.thinking ?? '').length
			_lines.push(`msg[${mi}] role=${msg.role} content[${ci}] sigLen=${sig.length} sig=${sig.slice(0, 24)}... thinkLen=${thinkLen}`)
		}
	}
	try {
		const _log = `${_lines.join('\n')}\n`
		await appendFile('/tmp/hal-thinking-debug.all.log', _log)
		await appendFile(`/tmp/hal-thinking-debug.${_session}.log`, _log)
	} catch {}
	if (params.tools?.length) body.tools = params.tools

	const res = await fetch('https://api.anthropic.com/v1/messages?beta=true', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${accessToken}`,
			'anthropic-version': '2023-06-01',
			'anthropic-beta': 'oauth-2025-04-20',
		},
		body: JSON.stringify(body),
		signal: params.signal,
	})

	if (!res.ok) {
		const body = (await res.text()).slice(0, 2000)
		yield { type: 'error', message: `API ${res.status}`, status: res.status, body }
		yield { type: 'done' }
		return
	}

	yield* parseStream(res.body!)
}

async function* parseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ProviderEvent> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buf = ''
	const tools = new Map<number, { id: string; name: string; json: string }>()
	const usage = { input: 0, output: 0 }

	while (true) {
		const { done, value } = await providerUtils.readWithTimeout(reader)
		if (done) break
		buf += decoder.decode(value, { stream: true })

		let nl: number
		while ((nl = buf.indexOf('\n')) !== -1) {
			const line = buf.slice(0, nl).trimEnd()
			buf = buf.slice(nl + 1)
			if (!line.startsWith('data: ')) continue

			let ev: any
			try { ev = JSON.parse(line.slice(6)) } catch { continue }

			if (ev.type === 'content_block_start') {
				const b = ev.content_block
				if (b.type === 'tool_use') tools.set(ev.index, { id: b.id, name: b.name, json: '' })
			} else if (ev.type === 'content_block_delta') {
				const d = ev.delta
				if (d.type === 'thinking_delta') yield { type: 'thinking', text: d.thinking }
				else if (d.type === 'signature_delta') yield { type: 'thinking_signature', signature: d.signature }
				else if (d.type === 'text_delta') yield { type: 'text', text: d.text }
				else if (d.type === 'input_json_delta') {
					const t = tools.get(ev.index)
					if (t) t.json += d.partial_json
				}
			} else if (ev.type === 'content_block_stop') {
				const t = tools.get(ev.index)
				if (t) {
					let input: unknown = {}
					try { input = JSON.parse(t.json) } catch {}
					yield { type: 'tool_call', id: t.id, name: t.name, input }
					tools.delete(ev.index)
				}
			} else if (ev.type === 'message_start' && ev.message?.usage) {
				const u = ev.message.usage
				usage.input += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
			} else if (ev.type === 'message_delta' && ev.usage) {
				usage.output += ev.usage.output_tokens ?? 0
			} else if (ev.type === 'error') {
				const body = ev.error?.message ?? JSON.stringify(ev.error)
				yield { type: 'error', message: 'Stream error', body }
			}
		}
	}

	yield { type: 'done', usage }
}

function isOpenAIReasoningSignature(signature: unknown): boolean {
	if (typeof signature !== 'string' || !signature.trim().startsWith('{')) return false
	try {
		const parsed = JSON.parse(signature)
		return parsed?.type === 'reasoning' && typeof parsed.encrypted_content === 'string' && parsed.encrypted_content.length > 0
	} catch {
		return false
	}
}

function formatForeignThinkingForAnthropic(thinking: unknown): string | null {
	if (typeof thinking !== 'string') return null
	const text = thinking.trim()
	if (!text) return null
	return `[thinking from a previous model; not a native Claude signature]\n${text}`
}

function sanitizeMessagesForAnthropic(msgs: any[]): any[] {
	if (!msgs.length) return msgs
	const out: any[] = []
	for (const msg of msgs) {
		if (!Array.isArray(msg.content)) {
			out.push(msg)
			continue
		}
		const content: any[] = []
		for (const block of msg.content) {
			if (block.type === 'thinking' && isOpenAIReasoningSignature(block.signature)) {
				const replayed = formatForeignThinkingForAnthropic(block.thinking)
				if (replayed) content.push({ type: 'text', text: replayed })
				continue
			}
			content.push(block)
		}
		if (content.length > 0) out.push({ ...msg, content })
	}
	return out
}

function cacheBreakpoints(msgs: any[]): any[] {
	if (!msgs.length) return msgs
	const out = structuredClone(msgs)
	const mark = (m: any) => {
		if (typeof m.content === 'string')
			m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
		else if (Array.isArray(m.content) && m.content.length)
			m.content[m.content.length - 1].cache_control = { type: 'ephemeral' }
	}
	mark(out[out.length - 1])
	if (out.length >= 3) {
		for (let i = out.length - 2; i >= 0; i--) {
			if (out[i].role === 'user') { mark(out[i]); break }
		}
	}
	return out
}

const provider: Provider = { name: 'anthropic', generate }
export default provider
