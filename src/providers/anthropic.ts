// Anthropic provider — streams Claude API responses as ProviderStreamEvents.
//
// Uses raw fetch + SSE parsing (no SDK dependency). Supports:
// - Streaming text, thinking, and tool_use content blocks
// - Prompt caching via cache_control breakpoints
// - Error handling with retry-after parsing
// - Extended thinking (adaptive for Opus 4.6+, enabled for other thinking models)

import type { Provider, ProviderRequest, ProviderStreamEvent, Message } from '../protocol.ts'
import { provider as providerUtils } from './provider.ts'
import { auth } from '../auth.ts'

// The ?beta=true query parameter is required for OAuth tokens.
// Without it, requests hit a different backend pool that returns 529 overloaded
// errors far more frequently.
const API_URL = 'https://api.anthropic.com/v1/messages?beta=true'
const API_VERSION = '2023-06-01'
const MAX_TOKENS = 16384

// Map Anthropic error types to HTTP status codes for consistent retry logic
const ERROR_TYPE_STATUS: Record<string, number> = {
	overloaded_error: 529,
	rate_limit_error: 429,
	api_error: 500,
	invalid_request_error: 400,
	authentication_error: 401,
	permission_error: 403,
	not_found_error: 404,
}

function errorTypeToStatus(type: unknown): number | undefined {
	return typeof type === 'string' ? ERROR_TYPE_STATUS[type] : undefined
}

// ── Message sanitization ──
// Strip or convert blocks that Anthropic doesn't understand (e.g. foreign
// thinking signatures from OpenAI reasoning models).

function isOpenAIReasoningSignature(signature: unknown): boolean {
	if (typeof signature !== 'string' || !signature.trim().startsWith('{')) return false
	try {
		const parsed = JSON.parse(signature)
		return parsed?.type === 'reasoning' && typeof parsed.encrypted_content === 'string'
	} catch {
		return false
	}
}

/** Convert non-Anthropic thinking blocks into plain text. */
function formatForeignThinking(thinking: unknown, sourceModel?: string): string | null {
	if (typeof thinking !== 'string') return null
	const text = thinking.trim()
	if (!text) return null
	const model = sourceModel ?? 'unknown'
	return `[model ${model} thinking]\n${text}`
}

/** Remove or transform blocks Anthropic can't handle. */
function sanitizeMessages(msgs: Message[]): any[] {
	if (!msgs.length) return msgs
	const out: any[] = []
	for (const msg of msgs) {
		if (!Array.isArray(msg.content)) {
			out.push(msg)
			continue
		}
		const content: any[] = []
		for (const block of msg.content as any[]) {
			if (block.type === 'thinking') {
				// Foreign thinking (e.g. OpenAI reasoning) → convert to text
				if (isOpenAIReasoningSignature(block.signature)) {
					const replayed = formatForeignThinking(block.thinking, block._model)
					if (replayed) content.push({ type: 'text', text: replayed })
					continue
				}
				// Native Anthropic thinking — pass through
				content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature })
				continue
			}
			content.push(block)
		}
		if (content.length > 0) out.push({ ...msg, content })
	}
	return out
}

// ── Prompt caching ──
// Mark the last user message (and second-to-last user message if conversation
// is long enough) with cache_control for Anthropic's prompt caching feature.

function applyCacheBreakpoints(msgs: any[]): any[] {
	if (!msgs.length) return msgs
	const out = structuredClone(msgs)

	const markLast = (m: any) => {
		if (typeof m.content === 'string') {
			m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
		} else if (Array.isArray(m.content) && m.content.length) {
			m.content[m.content.length - 1].cache_control = { type: 'ephemeral' }
		}
	}

	// Always mark the last message
	markLast(out[out.length - 1])

	// Also mark the second-to-last user message for better cache hit rates
	if (out.length >= 3) {
		for (let i = out.length - 2; i >= 0; i--) {
			if (out[i].role === 'user') { markLast(out[i]); break }
		}
	}

	return out
}

// ── SSE stream parser ──

async function* parseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ProviderStreamEvent> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buf = ''

	// Tool calls are assembled across content_block_start / delta / stop events
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
				if (b.type === 'tool_use') {
					tools.set(ev.index, { id: b.id, name: b.name, json: '' })
				}
			} else if (ev.type === 'content_block_delta') {
				const d = ev.delta
				if (d.type === 'thinking_delta') {
					yield { type: 'thinking', text: d.thinking }
				} else if (d.type === 'signature_delta') {
					yield { type: 'thinking_signature', signature: d.signature }
				} else if (d.type === 'text_delta') {
					yield { type: 'text', text: d.text }
				} else if (d.type === 'input_json_delta') {
					// Accumulate partial JSON for tool input
					const t = tools.get(ev.index)
					if (t) t.json += d.partial_json
				}
			} else if (ev.type === 'content_block_stop') {
				const t = tools.get(ev.index)
				if (t) {
					let input: any
					try {
						input = JSON.parse(t.json || '{}')
					} catch {
						yield {
							type: 'tool_call', id: t.id, name: t.name, input: {},
							rawJson: t.json,
							parseError: `Failed to parse tool input JSON (${t.json.length} chars): ${t.json.slice(0, 200)}`,
						}
						tools.delete(ev.index)
						continue
					}
					yield { type: 'tool_call', id: t.id, name: t.name, input, rawJson: t.json }
					tools.delete(ev.index)
				}
			} else if (ev.type === 'message_start' && ev.message?.usage) {
				// Input tokens include cache reads and cache creation
				const u = ev.message.usage
				usage.input += (u.input_tokens ?? 0)
					+ (u.cache_read_input_tokens ?? 0)
					+ (u.cache_creation_input_tokens ?? 0)
			} else if (ev.type === 'message_delta' && ev.usage) {
				usage.output += ev.usage.output_tokens ?? 0
			} else if (ev.type === 'error') {
				const msg = ev.error?.message ?? 'Stream error'
				const body = JSON.stringify(ev.error ?? ev)
				const status = errorTypeToStatus(ev.error?.type)
				try {
					const prev = await Bun.file('/tmp/compare/hal.txt').exists() ? await Bun.file('/tmp/compare/hal.txt').text() : ''
					await Bun.write('/tmp/compare/hal.txt', prev + `STREAM ERROR: status=${status} type=${ev.error?.type} body=${body}\n\n`)
				} catch {}
				yield { type: 'error', message: msg, status, body }
			}
		}
	}

	yield { type: 'done', usage }
}

// ── Generate ──

async function* generate(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
	await auth.ensureFresh('anthropic')
	const cred = auth.getCredential('anthropic')
	if (!cred) {
		yield { type: 'error', message: 'No Anthropic credentials. Run: bun scripts/login-anthropic.ts' }
		yield { type: 'done' }
		return
	}

	// Determine thinking mode based on model
	const isAdaptive = /^claude-(opus|sonnet)-4-6/.test(req.model)
	const supportsThinking = /^claude-(opus|sonnet)/.test(req.model)

	const isOAuth = cred.type === 'token'

	// Build system blocks with cache control.
	// OAuth requires the Claude Code identity prefix — without it, the API rejects the request.
	const system: any[] = []
	if (isOAuth) {
		system.push({ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." })
	}
	system.push({ type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } })

	// Sanitize messages (handle foreign thinking blocks) then add cache breakpoints
	const messages = applyCacheBreakpoints(sanitizeMessages(req.messages))

	const body: any = {
		model: req.model,
		max_tokens: MAX_TOKENS,
		stream: true,
		system,
		messages,
	}

	// Enable extended thinking for capable models
	if (supportsThinking) {
		body.thinking = isAdaptive
			? { type: 'adaptive' }
			: { type: 'enabled', budget_tokens: Math.min(10000, MAX_TOKENS - 1) }
	}

	if (req.tools?.length) {
		body.tools = req.tools
	}

	const authHeader = isOAuth
		? { 'Authorization': `Bearer ${cred.value}` }
		: { 'x-api-key': cred.value }

	const url = API_URL
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		...authHeader,
		'anthropic-version': API_VERSION,
		'anthropic-beta': isOAuth
			? 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14'
			: 'fine-grained-tool-streaming-2025-05-14',
		// OAuth requires these headers to identify as Claude Code
		...(isOAuth ? { 'user-agent': 'claude-cli/2.1.75', 'x-app': 'cli' } : {}),
	}

	// Debug dump to /tmp/compare/hal.txt — remove once 529 issue is resolved
	try {
		const debugBody = JSON.parse(JSON.stringify(body))
		if (debugBody.messages) for (const m of debugBody.messages) {
			if (typeof m.content === 'string' && m.content.length > 200) m.content = m.content.slice(0, 200) + '...'
			if (Array.isArray(m.content)) for (const b of m.content) {
				if (b.type === 'text' && b.text?.length > 200) b.text = b.text.slice(0, 200) + '...'
			}
		}
		const dump = `=== HAL REQUEST ${new Date().toISOString()} ===\nURL: ${url}\nHEADERS: ${JSON.stringify(headers, null, 2)}\nBODY: ${JSON.stringify(debugBody, null, 2)}\n\n`
		const prev = await Bun.file('/tmp/compare/hal.txt').exists() ? await Bun.file('/tmp/compare/hal.txt').text() : ''
		await Bun.write('/tmp/compare/hal.txt', prev + dump)
	} catch {}

	const res = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: req.signal,
	})

	// Debug: log response
	try {
		const rd = `RESPONSE: ${res.status} ${res.statusText}\n\n`
		const prev = await Bun.file('/tmp/compare/hal.txt').text()
		await Bun.write('/tmp/compare/hal.txt', prev + rd)
	} catch {}

	if (!res.ok) {
		const text = (await res.text()).slice(0, 2000)
		try {
			const prev = await Bun.file('/tmp/compare/hal.txt').text()
			await Bun.write('/tmp/compare/hal.txt', prev + `ERROR BODY: ${text}\n\n`)
		} catch {}
		const retryAfterMs = providerUtils.parseRetryDelay(res, text)
		yield { type: 'error', message: `Anthropic API ${res.status}`, status: res.status, body: text, retryAfterMs }
		yield { type: 'done' }
		return
	}

	yield* parseStream(res.body!)
}

export const anthropicProvider: Provider = { generate }
