// Anthropic Messages provider with OAuth (Claude subscription) or API
// key credentials from src/host/auth.ts. Wire mapping:
// tasks/7f/mapping.md; OAuth contract: tasks/ya/anthropic.ts.

import type { AssistantBlock, StopReason, StreamEvent, Usage, UserBlock } from '../common/blocks.ts'
import { auth } from './auth.ts'
import { provider, type ProviderRequest, type SseMessage } from './provider.ts'

// OAuth tokens are rejected unless the first system block is exactly this.
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const OAUTH_BETAS = 'claude-code-20250219,oauth-2025-04-20'
const TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14'
// The Claude Code version reported in the OAuth user-agent, as the
// Agent SDK does; the entrypoint slot honestly says "hal".
const CLAUDE_CODE_VERSION = '2.1.280'
// Smallest thinking budget the API accepts.
const MIN_THINKING = 1024

const ephemeral = { type: 'ephemeral' }

// Redacted thinking has no text; its data rides in the signature.
function redactedData(signature: string): string | undefined {
	if (!signature.startsWith('{')) return undefined
	try {
		let v = JSON.parse(signature)
		return typeof v?.redacted === 'string' ? v.redacted : undefined
	} catch {
		return undefined
	}
}

function userBlock(b: UserBlock): unknown {
	if (b.type === 'text') return { type: 'text', text: b.text }
	return { type: 'tool_result', tool_use_id: b.id, content: b.output, ...(b.isError ? { is_error: true } : {}) }
}

// Only thinking signed by this provider can be sent back; foreign or
// unsigned thinking is dropped (the API rejects it).
function assistantBlock(b: AssistantBlock): unknown {
	if (b.type === 'text') return { type: 'text', text: b.text }
	if (b.type === 'tool_call') return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
	if (b.provider !== 'anthropic' || !b.signature) return undefined
	let data = redactedData(b.signature)
	return data !== undefined ? { type: 'redacted_thinking', data } : { type: 'thinking', thinking: b.text, signature: b.signature }
}

function toMessages(req: ProviderRequest): any[] {
	let out: any[] = []
	for (let m of req.messages) {
		let content = m.role === 'user' ? m.blocks.map(userBlock) : m.blocks.map(assistantBlock).filter(Boolean)
		// The API rejects empty text blocks and empty messages.
		content = content.filter((b: any) => b.type !== 'text' || b.text !== '')
		if (content.length) out.push({ role: m.role, content })
	}
	// Cache the whole prefix: the next turn starts with it.
	let last = out.at(-1)?.content.at(-1)
	if (last) last.cache_control = ephemeral
	return out
}

// Models that reject a manual thinking budget.
function adaptive(model: string): boolean {
	return /^claude-(?:opus-(?:4-[678]|5(?:-|$))|sonnet-(?:4-6|5(?:-|$))|fable-5(?:-|$))/.test(model)
}

function body(req: ProviderRequest, oauth: boolean): Record<string, unknown> {
	let maxTokens = req.maxTokens ?? anthropic.maxTokens()
	let system: unknown[] = []
	if (oauth) system.push({ type: 'text', text: IDENTITY })
	// The model reads the blocks joined with no separator; a blank line
	// keeps ours a paragraph of its own (constant, so caching holds).
	if (req.system) system.push({ type: 'text', text: oauth ? `\n\n${req.system}` : req.system, cache_control: ephemeral })
	let b: Record<string, unknown> = { model: req.model, max_tokens: maxTokens, stream: true, messages: anthropic.toMessages(req) }
	if (system.length) b.system = system
	if (req.tools?.length) b.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
	if (adaptive(req.model)) b.thinking = { type: 'adaptive' }
	else if (/^claude-(opus|sonnet)/.test(req.model) && maxTokens > MIN_THINKING) {
		b.thinking = { type: 'enabled', budget_tokens: Math.max(MIN_THINKING, Math.min(anthropic.thinkingBudget(), maxTokens - 1024)) }
	}
	return b
}

// Headers for the next usable account (auth.ts), which may be chosen
// for `model`.
async function headers(model?: string): Promise<{ headers: Record<string, string>; oauth: boolean; account: string }> {
	let cred = await auth.anthropic(model)
	let oauth = cred.type === 'token'
	let headers: Record<string, string> = oauth
		? {
				authorization: `Bearer ${cred.value}`,
				'anthropic-beta': `${OAUTH_BETAS},${TOOL_STREAMING_BETA}`,
				'user-agent': `claude-cli/${CLAUDE_CODE_VERSION} (external, hal)`,
				'x-app': 'cli',
			}
		: { 'x-api-key': cred.value, 'anthropic-beta': TOOL_STREAMING_BETA }
	headers['anthropic-version'] = '2023-06-01'
	return { headers, oauth, account: cred.account }
}

async function request(req: ProviderRequest) {
	let { headers, oauth, account } = await anthropic.headers(req.model)
	return { url: anthropic.apiUrl(), headers, body: anthropic.body(req, oauth), account }
}

// The models the account may use (GET /v1/models), else the known ones.
async function models(signal: AbortSignal): Promise<string[]> {
	try {
		let url = new URL(anthropic.apiUrl())
		url.pathname = url.pathname.replace(/\/messages$/, '/models')
		url.searchParams.set('limit', '1000')
		let res = await provider.fetch(String(url), { headers: (await anthropic.headers()).headers, signal })
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		let body = (await res.json()) as { data?: { id?: unknown }[] }
		let ids = (body.data ?? []).flatMap((m) => (typeof m.id === 'string' ? [m.id] : []))
		if (ids.length) return ids
	} catch {}
	return anthropic.knownModels()
}

const reasons: Record<string, StopReason> = {
	end_turn: 'end',
	stop_sequence: 'end',
	pause_turn: 'end',
	tool_use: 'tool_use',
	max_tokens: 'max_tokens',
	model_context_window_exceeded: 'max_tokens',
	refusal: 'refusal',
}

// Anthropic error types, as HTTP statuses for retry decisions.
const errorStatus: Record<string, number> = {
	overloaded_error: 529,
	rate_limit_error: 429,
	api_error: 500,
	invalid_request_error: 400,
	authentication_error: 401,
	permission_error: 403,
	not_found_error: 404,
}

function usage(u: any): Usage | undefined {
	if (!u) return undefined
	let out: Usage = {}
	if (typeof u.input_tokens === 'number') out.input = u.input_tokens
	if (typeof u.output_tokens === 'number') out.output = u.output_tokens
	if (typeof u.cache_read_input_tokens === 'number') out.cacheRead = u.cache_read_input_tokens
	if (typeof u.cache_creation_input_tokens === 'number') out.cacheWrite = u.cache_creation_input_tokens
	return Object.keys(out).length ? out : undefined
}

async function* parse(messages: AsyncIterable<SseMessage>): AsyncGenerator<StreamEvent> {
	// Tool input arrives as JSON fragments per content block index.
	let tools = new Map<number, { id: string; name: string; json: string; input: unknown }>()
	let reason: StopReason | undefined
	for await (let m of messages) {
		let ev = JSON.parse(m.data)
		switch (ev.type) {
			case 'message_start': {
				let u = usage(ev.message?.usage)
				if (u) yield { type: 'usage', usage: u }
				break
			}
			case 'content_block_start': {
				let b = ev.content_block
				if (b?.type === 'tool_use') tools.set(ev.index, { id: b.id, name: b.name, json: '', input: b.input })
				else if (b?.type === 'redacted_thinking') yield { type: 'signature', value: JSON.stringify({ redacted: b.data }) }
				break
			}
			case 'content_block_delta': {
				let d = ev.delta
				if (d?.type === 'text_delta') yield { type: 'text', text: d.text }
				else if (d?.type === 'thinking_delta') yield { type: 'thinking', text: d.thinking }
				else if (d?.type === 'signature_delta') yield { type: 'signature', value: d.signature }
				else if (d?.type === 'input_json_delta') {
					let t = tools.get(ev.index)
					if (t) t.json += d.partial_json
				}
				break
			}
			case 'content_block_stop': {
				let t = tools.get(ev.index)
				if (!t) break
				tools.delete(ev.index)
				// Argument-less calls may send no deltas, only the start input.
				let input: unknown = t.input ?? {}
				if (t.json) {
					try {
						input = JSON.parse(t.json)
					} catch {
						input = undefined
					}
				}
				if (!input || typeof input !== 'object' || Array.isArray(input)) {
					yield { type: 'error', message: `Invalid JSON input for tool call '${t.name}'`, body: t.json }
					return
				}
				yield { type: 'tool_call', id: t.id, name: t.name, input: input as Record<string, unknown> }
				break
			}
			case 'message_delta': {
				let u = usage(ev.usage)
				if (u) yield { type: 'usage', usage: u }
				if (ev.delta?.stop_reason) reason = reasons[ev.delta.stop_reason] ?? 'end'
				break
			}
			case 'message_stop':
				yield { type: 'done', reason: reason ?? 'end' }
				return
			case 'error': {
				let e = ev.error ?? {}
				yield { type: 'error', message: e.message ?? 'Stream error', status: errorStatus[e.type], body: m.data }
				return
			}
		}
	}
}

// Registers the provider. Idempotent.
function init(): void {
	provider.register('anthropic', { request: anthropic.request, parse: anthropic.parse, rejected: (account) => auth.rejected(account), models: (signal) => anthropic.models(signal) })
}

export const anthropic = {
	// ?beta=true is required for OAuth tokens; without it requests land
	// on a pool that answers 529 overloaded far more often.
	apiUrl: () => 'https://api.anthropic.com/v1/messages?beta=true',
	// Current Claude models allow at least 64k output: big file writes.
	maxTokens: () => 64_000,
	thinkingBudget: () => 10_000,
	// Offered when the account's list can't be read.
	knownModels: () => ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5', 'claude-sonnet-5'],
	toMessages,
	body,
	headers,
	request,
	models,
	parse,
	init,
}
