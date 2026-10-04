// Provider-neutral conversation blocks and stream events. How they map
// onto Anthropic Messages, OpenAI Responses and Chat Completions is
// recorded in tasks/7f/mapping.md.

export type TextBlock = { type: 'text'; text: string; naming?: true }

// `signature` is opaque and only meaningful to `provider`, the provider
// that produced it; others must not send it back. History keeps it in
// the session blob `signatureBlob` instead (task s1).
export type ThinkingBlock = { type: 'thinking'; text: string; signature?: string; signatureBlob?: string; provider?: string }

export type ToolCallBlock = { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }

export type ToolResultBlock = { type: 'tool_result'; id: string; output: string; isError?: boolean; image?: ImageBlock }

// An attached image (task 2a): a reference to the session's blob, never
// its bytes; providers read those when they build a request. `bytes`:
// its decoded size, for display.
export type ImageBlock = { type: 'image'; blob: string; mediaType: string; bytes?: number }

// Who sent a prompt's text (task rj): `from` is the session that sent
// it, `label` names it for people and the model (tab, id and name as
// they were then); none, the human. `advisory`: the model may read it
// without dropping its work (the send tool's default). `steering`:
// this text was submitted to steer an active turn; retained for display.
// `summary`: one line for the user, heading the message folded.
// queuedAt: original inbox receipt time, retained after queue delivery.
export type Sender = { queuedAt?: string; from?: string; label?: string; advisory?: true; steering?: true; summary?: string; origin?: 'model'; generatingCommand?: 'clear' }

// A prompt's text, saying who sent it.
export type UserText = TextBlock & Sender

export type UserBlock = UserText | ToolResultBlock | ImageBlock
export type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock

export type Message = { role: 'user'; blocks: UserBlock[] } | { role: 'assistant'; blocks: AssistantBlock[] }

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
	// Set when the caller aborted; the turn was cancelled, not failed.
	cancelled?: boolean
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
	| { type: 'usage'; usage: Usage }
	| DoneEvent
	| ErrorEvent

// An assistant turn folded from stream events.
export type Turn = {
	provider: string
	blocks: AssistantBlock[]
	usage: Usage
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
			turn.blocks.push({ type: 'tool_call', id: event.id, name: event.name, input: event.input })
			break
		case 'usage':
			for (let [k, v] of Object.entries(event.usage)) if (v !== undefined) turn.usage[k as keyof Usage] = v
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
