// OpenAI Responses provider over HTTP streaming (SSE), as the old Hal
// spoke it (tasks/q7/old-openai.ts; wire mapping: tasks/7f/mapping.md).
// Credentials come from auth.ts: a ChatGPT OAuth token (/login chatgpt)
// without the api.responses.write scope goes to the Codex backend on
// chatgpt.com with its account id; an API key (OPENAI_API_KEY) or a
// token with that scope goes to api.openai.com.
//
// Reasoning comes back as an encrypted item (store: false keeps nothing
// on OpenAI's side); its JSON is the thinking block's signature and is
// replayed as a reasoning item whose summary is rebuilt from the text.

import type { AssistantBlock, StopReason, StreamEvent, Usage } from '../common/blocks.ts'
import { auth, jwtClaims } from './auth.ts'
import { modelsDev } from './models-dev.ts'
import { provider, type ProviderRequest, type SseMessage } from './provider.ts'

const SCOPE = 'api.responses.write'
// A ChatGPT subscription's input limit: 400k window = 272k input + 128k
// reserved output (old Hal: subscriptionContextWindow).
const SUBSCRIPTION_WINDOW = 272_000

function claims(token: string): { accountId?: string; api: boolean } {
	let c = jwtClaims(token)
	let id = c?.['https://api.openai.com/auth']?.chatgpt_account_id
	let api = [c?.scp, c?.scope].some((v) => (Array.isArray(v) ? v.includes(SCOPE) : typeof v === 'string' && v.split(/\s+/).includes(SCOPE)))
	return { ...(typeof id === 'string' && id && { accountId: id }), api }
}

function input(req: ProviderRequest): unknown[] {
	let out: unknown[] = []
	for (let m of req.messages) {
		if (m.role === 'user') {
			let parts: unknown[] = []
			for (let b of m.blocks) {
				if (b.type === 'tool_result') out.push({ type: 'function_call_output', call_id: b.id, output: b.isError ? `Error: ${b.output}` : b.output })
				else if (b.type === 'text') parts.push({ type: 'input_text', text: b.text })
				else {
					let data = req.image?.(b.blob)
					parts.push(data === undefined ? { type: 'input_text', text: provider.imageNote('its file is gone') } : { type: 'input_image', detail: 'auto', image_url: `data:${b.mediaType};base64,${data}` })
				}
			}
			if (parts.length) out.push({ role: 'user', content: parts })
			continue
		}
		for (let b of m.blocks) {
			let item = assistantItem(b)
			if (item) out.push(item)
		}
	}
	return out
}

// Only reasoning this provider encrypted can go back; other thinking is
// dropped, as anthropic.ts drops foreign signatures.
function assistantItem(b: AssistantBlock): unknown {
	if (b.type === 'text') return b.text ? { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: b.text, annotations: [] }] } : undefined
	if (b.type === 'tool_call') return { type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) }
	if (b.provider !== 'openai' || !b.signature) return undefined
	let encrypted: unknown
	try {
		encrypted = JSON.parse(b.signature)?.encrypted_content
	} catch {}
	if (typeof encrypted !== 'string') return undefined
	// The Codex backend rejects reasoning items without `summary`.
	return { type: 'reasoning', summary: b.text.trim() ? [{ type: 'summary_text', text: b.text.trim() }] : [], encrypted_content: encrypted }
}

function reasons(model: string): boolean {
	return /^(gpt-5|o\d|codex)/.test(model)
}

function body(req: ProviderRequest, codex: boolean): Record<string, unknown> {
	let b: Record<string, unknown> = { model: req.model, store: false, stream: true, input: openai.input(req) }
	if (req.system) b.instructions = req.system
	if (req.tools?.length) {
		b.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema }))
		b.tool_choice = 'auto'
		b.parallel_tool_calls = true
	}
	if (reasons(req.model)) {
		let effort = openai.effort(req.model)
		b.reasoning = { summary: 'auto', ...(effort && { effort }) }
		b.include = ['reasoning.encrypted_content']
	}
	if (req.sessionId) b.prompt_cache_key = req.sessionId
	if (codex) b.text = { verbosity: 'high' }
	// The Codex backend rejects max_output_tokens.
	else if (req.maxTokens) b.max_output_tokens = req.maxTokens
	return b
}

async function request(req: ProviderRequest) {
	let cred = await auth.openai(req.model, { session: req.sessionId })
	let headers: Record<string, string> = { authorization: `Bearer ${cred.value}`, accept: 'text/event-stream' }
	let codex = false
	if (cred.type === 'token') {
		let c = claims(cred.value)
		codex = !c.api
		let accountId = c.accountId ?? cred.accountId
		if (codex && !accountId) throw Object.assign(new Error(`the OpenAI token of ${cred.account} names no ChatGPT account; ${auth.logIn('openai')}`), { failure: 'auth' })
		if (codex) Object.assign(headers, { originator: 'hal', 'chatgpt-account-id': accountId })
	}
	return { url: codex ? openai.codexUrl() : openai.apiUrl(), headers, body: openai.body(req, codex), account: cred.account }
}

// Error codes in a stream, as HTTP statuses for retry decisions.
const errorStatus: Record<string, number> = { rate_limit_exceeded: 429, usage_limit_reached: 429, server_error: 500, server_is_overloaded: 503 }

function error(e: any, data: string): StreamEvent {
	let status = errorStatus[e?.code] ?? errorStatus[e?.type]
	return { type: 'error', message: typeof e?.message === 'string' ? e.message : 'Response failed', ...(status && { status }), body: JSON.stringify(e ?? data) }
}

function usage(u: any): Usage {
	let cached = u.input_tokens_details?.cached_tokens ?? 0
	let out: Usage = {}
	if (typeof u.input_tokens === 'number') out.input = Math.max(0, u.input_tokens - cached)
	if (typeof u.output_tokens === 'number') out.output = u.output_tokens
	if (cached) out.cacheRead = cached
	return out
}

const incomplete: Record<string, StopReason> = { max_output_tokens: 'max_tokens', content_filter: 'refusal' }

async function* parse(messages: AsyncIterable<SseMessage>): AsyncGenerator<StreamEvent> {
	// Function call arguments arrive as fragments per output index.
	let calls = new Map<number, { id: string; name: string; args: string }>()
	let called = false
	for await (let m of messages) {
		let ev = JSON.parse(m.data)
		let index = ev.output_index ?? 0
		switch (ev.type) {
			case 'response.output_item.added':
				if (ev.item?.type === 'function_call') calls.set(index, { id: ev.item.call_id ?? `call_${index}`, name: ev.item.name ?? '', args: '' })
				break
			case 'response.reasoning_summary_part.added':
				if (ev.summary_index > 0) yield { type: 'thinking', text: '\n\n' }
				break
			case 'response.reasoning_summary_text.delta':
				if (ev.delta) yield { type: 'thinking', text: ev.delta }
				break
			case 'response.output_text.delta':
			case 'response.refusal.delta':
				if (ev.delta) yield { type: 'text', text: ev.delta }
				break
			case 'response.function_call_arguments.delta': {
				let call = calls.get(index)
				if (call) call.args += ev.delta ?? ''
				break
			}
			case 'response.output_item.done': {
				let item = ev.item
				if (item?.type === 'reasoning' && typeof item.encrypted_content === 'string') yield { type: 'signature', value: JSON.stringify({ encrypted_content: item.encrypted_content }) }
				if (item?.type !== 'function_call') break
				let call = calls.get(index) ?? { id: item.call_id, name: item.name, args: '' }
				let json = typeof item.arguments === 'string' ? item.arguments : call.args
				let args: unknown
				try {
					args = JSON.parse(json || '{}')
				} catch {}
				if (!args || typeof args !== 'object' || Array.isArray(args)) {
					yield { type: 'error', message: `Invalid JSON arguments for tool call '${call.name}'`, body: json }
					return
				}
				called = true
				yield { type: 'tool_call', id: call.id, name: call.name, input: args as Record<string, unknown> }
				break
			}
			case 'response.completed':
			case 'response.incomplete': {
				let r = ev.response ?? {}
				if (r.usage) yield { type: 'usage', usage: usage(r.usage) }
				if (ev.type === 'response.completed') {
					yield { type: 'done', reason: called ? 'tool_use' : 'end' }
					return
				}
				let why = r.incomplete_details?.reason
				if (incomplete[why]) yield { type: 'done', reason: incomplete[why] }
				else yield { type: 'error', message: `Response incomplete${why ? `: ${why}` : ''}` }
				return
			}
			case 'response.failed':
				// The failed response echoes the whole request: keep only its error.
				yield error(ev.response?.error, m.data)
				return
			case 'error':
				yield error(ev.error ?? ev, m.data)
				return
		}
	}
}

// Whether the first openai account is a ChatGPT subscription token.
function subscription(): boolean {
	try {
		let entry = auth.all('openai').list[0]?.entry
		return typeof entry?.accessToken === 'string' && !claims(entry.accessToken).api
	} catch {
		return false
	}
}

// A subscription caps input at 272k whatever the API model allows.
function contextWindow(model: string): number | undefined {
	let listed = modelsDev.contextWindow(`openai/${model}`)
	return openai.subscription() ? Math.min(listed ?? SUBSCRIPTION_WINDOW, SUBSCRIPTION_WINDOW) : listed
}

// Registers the provider. Idempotent.
function init(): void {
	provider.register('openai', {
		request: openai.request,
		parse: openai.parse,
		rejected: (account) => auth.rejected(account, 'openai'),
		known: () => openai.knownModels(),
		contextWindow: (model) => openai.contextWindow(model),
	})
}

export const openai = {
	apiUrl: () => 'https://api.openai.com/v1/responses',
	codexUrl: () => 'https://chatgpt.com/backend-api/codex/responses',
	// Reasoning effort for a model; undefined leaves the model's default.
	effort: (_model: string): string | undefined => undefined,
	// The old Hal's GPT ids, offered beside models.dev's list.
	knownModels: () => ['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
	input,
	body,
	request,
	parse,
	subscription,
	contextWindow,
	init,
}
