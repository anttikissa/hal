// Provider-neutral conversation blocks and stream events. How they map
// onto Anthropic Messages, OpenAI Responses and Chat Completions is
// recorded in tasks/7f/mapping.md. These types are both the wire format
// (protocol events) and the persisted one (history records), so a field
// change requires converting older histories before readers open them.
// Tasks: 7f, rqq.

export type TextBlock = { type: 'text'; text: string; naming?: true }

// `signature` is opaque and only meaningful to `provider`, the provider
// that produced it; others must not send it back. History keeps it in
// the session blob `signatureBlob` instead (task s1).
export type ThinkingBlock = { type: 'thinking'; text: string; signature?: string; signatureBlob?: string; provider?: string }

// `action`: the native Action text this internal call came from (task
// aks); replay sends that back instead of name and input.
export type ToolCallBlock = { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; action?: string }

// `ms`: the call's wall time (task wm0); records before it have none.
// `interrupted`: a new user message canceled the call before it started
// or stopped it running (task ker); not a failure.
// `diff`: a numbered diff of what the call changed (EDIT), for display;
// providers never see it.
export type ToolResultBlock = { type: 'tool_result'; id: string; output: string; isError?: boolean; image?: ImageBlock; diff?: string; ms?: number; interrupted?: 'canceled' | 'stopped' }

// An attached image (task 2a): a reference to the session's blob, never
// its bytes; providers read those when they build a request. `bytes`:
// its decoded size, for display.
export type ImageBlock = { type: 'image'; blob: string; mediaType: string; bytes?: number }

// Who sent a prompt's text (task rj): `from` is the session that sent
// it, `label` names it for people and the model (tab, id and name as
// they were then); none, the human. Advisory is independent of timing:
// automatic reports and deliberate sends retain their existing provenance.
// Delivery records a busy message's scheduling tier, not an idle prompt.
// `summary`: one line for the user, heading the message folded.
// queuedAt: original inbox receipt time, retained after queue delivery.
// call: the model's tool call that ran a command (rebase keeps it open).
export type Sender = { queuedAt?: string; from?: string; label?: string; advisory?: true; delivery?: 'now' | 'next-round' | 'after-turn'; summary?: string; report?: 'question' | 'summary'; origin?: 'model'; call?: string; generatingCommand?: 'clear' }

// A prompt's text, saying who sent it.
export type UserText = TextBlock & Sender

export type UserBlock = UserText | ToolResultBlock | ImageBlock
export type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock

// `cache`: an earlier request's input ended after this many of the
// message's blocks; a provider may mark it for prompt caching (task g5j).
export type Message = ({ role: 'user'; blocks: UserBlock[] } | { role: 'assistant'; blocks: AssistantBlock[] }) & { cache?: number }

// Token counts. Cumulative: each usage event overwrites what it carries.
export type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal'

// `explanation`: why the provider refused, if it said.
export type DoneEvent = { type: 'done'; reason: StopReason; explanation?: string }
export type ErrorEvent = {
	type: 'error'
	message: string
	status?: number
	body?: string
	// Set when the caller aborted; the turn was canceled, not failed.
	canceled?: boolean
	// What fixes the failure (tasks/j1/states.md, Failures): time
	// (temporary), time or another account (limited), a login (auth).
	// Absent: nothing the host can do; the turn ends in error.
	failure?: 'temporary' | 'limited' | 'auth'
	// When to try again (epoch ms), if the provider said.
	retryAt?: number
}

// A stream ends with exactly one terminal event: done or error.
export type StreamEvent =
	| { type: 'text'; text: string; naming?: true }
	| { type: 'thinking'; text: string }
	// Closes the current thinking block (or makes an empty one).
	| { type: 'signature'; value: string }
	| ({ type: 'tool_call' } & Omit<ToolCallBlock, 'type'>)
	// `account`: the credentials' label that served the request.
	| { type: 'usage'; usage: Usage; account?: string }
	| DoneEvent
	| ErrorEvent

// An assistant turn folded from stream events.
export type Turn = {
	provider: string
	blocks: AssistantBlock[]
	usage: Usage
	account?: string
	end?: DoneEvent | ErrorEvent
}

function newTurn(provider: string): Turn {
	return { provider, blocks: [], usage: {} }
}

// Fold one event into the turn, merging consecutive deltas of a kind.
// A signature closes its thinking block.
function apply(turn: Turn, event: StreamEvent): void {
	let last = turn.blocks.at(-1)
	switch (event.type) {
		case 'text':
			if (last?.type === 'text') last.text += event.text
			else turn.blocks.push({ type: 'text', text: event.text, ...(event.naming && { naming: true }) })
			break
		case 'thinking':
			if (last?.type === 'thinking' && last.signature === undefined) last.text += event.text
			else turn.blocks.push({ type: 'thinking', text: event.text })
			break
		case 'signature':
			if (last?.type === 'thinking' && last.signature === undefined) Object.assign(last, { signature: event.value, provider: turn.provider })
			else turn.blocks.push({ type: 'thinking', text: '', signature: event.value, provider: turn.provider })
			break
		case 'tool_call':
			turn.blocks.push({ type: 'tool_call', id: event.id, name: event.name, input: event.input, ...(event.action !== undefined && { action: event.action }) })
			break
		case 'usage':
			for (let [k, v] of Object.entries(event.usage)) if (v !== undefined) turn.usage[k as keyof Usage] = v
			if (event.account) turn.account = event.account
			break
		default:
			turn.end = event
	}
}

function collect(events: Iterable<StreamEvent>, provider: string): Turn {
	let turn = blocks.newTurn(provider)
	for (let e of events) blocks.apply(turn, e)
	return turn
}

// "provider/model", split on the first slash: the model part may
// contain slashes itself (openrouter/anthropic/claude-...).
function parseModelId(id: string): { provider: string; model: string } | undefined {
	let slash = id.indexOf('/')
	if (slash <= 0 || slash === id.length - 1) return undefined
	return { provider: id.slice(0, slash), model: id.slice(slash + 1) }
}

export const blocks = { newTurn, apply, collect, parseModelId }
