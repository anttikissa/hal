// IPC protocol types — commands, events, shared types.
//
// Defines the contract between client and server. Commands flow client→server,
// events flow server→client. Both are serialized to ASONL files via ipc.ts.

// ── Event types (server → client) ──

export type EventType =
	| 'runtime-start'
	| 'host-released'
	| 'sessions'
	| 'prompt'
	| 'response'
	| 'info'
	| 'error'
	| 'stream-start'
	| 'stream-delta'
	| 'stream-end'
	| 'tool-call'
	| 'tool-result'
	| 'status'

// ── Command types (client → server) ──

export type CommandType = 'prompt' | 'steer' | 'open' | 'close' | 'resume' | 'abort' | 'compact'

// ── Tool call types ──

export type ToolName = 'analyze_history' | 'bash' | 'read' | 'read_url' | 'write' | 'edit' | 'glob' | 'grep' | 'eval' | 'send' | 'google'

// ── Message types (for API conversation format) ──

export type MessageRole = 'user' | 'assistant'

export interface ContentBlock {
	type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image'
	text?: string
	thinking?: string
	signature?: string
	id?: string // tool_use id
	name?: string // tool_use name
	input?: any // tool_use input
	tool_use_id?: string // tool_result reference
	content?: string | any[] // tool_result content
}

export interface Message {
	role: MessageRole
	content: string | ContentBlock[]
}

// ── Tool definitions (sent to providers) ──

export interface ToolDef {
	name: string
	description: string
	input_schema: Record<string, any>
}

// ── Provider interface ──
// Providers (Plan 4) will implement this. Defined here so the agent loop
// can reference it without circular imports.

export interface ProviderStreamEvent {
	type: 'text' | 'thinking' | 'thinking_signature' | 'tool_call' | 'server_tool' | 'status' | 'error' | 'done'
	text?: string
	signature?: string
	// tool_call fields
	id?: string
	name?: string
	input?: any
	parseError?: string
	rawJson?: string
	// server_tool fields — opaque content blocks from server-side tools (e.g. web_search).
	// These go into the assistant message content verbatim and need no local execution.
	serverBlocks?: any[]
	// status fields
	activity?: string
	// error fields
	message?: string
	status?: number
	body?: string
	endpoint?: string // the URL the request was sent to
	retryAfterMs?: number
	// done fields
	usage?: { input: number; output: number }
}

export interface ProviderRequest {
	messages: Message[]
	model: string
	systemPrompt: string
	tools: ToolDef[]
	signal?: AbortSignal
	sessionId?: string
}

export interface Provider {
	generate(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent>
}

// ── Event ID generator ──

let _counter = 0

function eventId(): string {
	return `${Date.now().toString(36)}-${(++_counter).toString(36)}`
}

export const protocol = { eventId }
