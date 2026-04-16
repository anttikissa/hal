// IPC protocol types — commands, events, shared types.
//
// Defines the contract between client and server. Commands flow client→server,
// events flow server→client. Both are serialized to ASONL files via ipc.ts.

// ── Event types (server → client) ──

export type EventType =
	| 'runtime-start'
	| 'host-released'
	| 'prompt'
	| 'response'
	| 'info'
	| 'error'
	| 'stream-start'
	| 'stream-delta'
	| 'stream-end'
	| 'tool-call'
	| 'tool-result'

// ── Command types (client → server) ──

export type CommandType = 'prompt' | 'continue' | 'open' | 'close' | 'resume' | 'abort' | 'reset' | 'compact' | 'move' | 'rename' | 'spawn'

export type SpawnMode = 'fork' | 'fresh'

// Commands are stored directly in commands.asonl. Keep them structured and
// explicit so the log stays readable; never smuggle another serialized object
// through a generic text field.
export interface CommandBase {
	sessionId?: string
	createdAt?: string
}

export interface PromptCommand extends CommandBase {
	type: 'prompt'
	text: string
	source?: string
}

export interface ContinueCommand extends CommandBase {
	type: 'continue'
}

export interface OpenNewCommand extends CommandBase {
	type: 'open'
}

export interface OpenForkCommand extends CommandBase {
	type: 'open'
	forkSessionId: string
}

export interface OpenAfterCommand extends CommandBase {
	type: 'open'
	afterSessionId: string
}

export interface CloseCommand extends CommandBase {
	type: 'close'
}

export interface ResumeCommand extends CommandBase {
	type: 'resume'
	selector?: string
}

export interface AbortCommand extends CommandBase {
	type: 'abort'
}

export interface ResetCommand extends CommandBase {
	type: 'reset'
}

export interface CompactCommand extends CommandBase {
	type: 'compact'
}

export interface MoveCommand extends CommandBase {
	type: 'move'
	position: number
}

export interface RenameCommand extends CommandBase {
	type: 'rename'
	name: string
}

export interface SpawnCommandData {
	task: string
	mode: SpawnMode
	model?: string
	cwd?: string
	title?: string
	closeWhenDone?: boolean
	childSessionId?: string
}

export interface SpawnCommand extends CommandBase {
	type: 'spawn'
	spawn: SpawnCommandData
}

export type Command =
	| PromptCommand
	| ContinueCommand
	| OpenNewCommand
	| OpenForkCommand
	| OpenAfterCommand
	| CloseCommand
	| ResumeCommand
	| AbortCommand
	| ResetCommand
	| CompactCommand
	| MoveCommand
	| RenameCommand
	| SpawnCommand

// ── Tool call types ──

export type ToolName =
	| 'analyze_history'
	| 'bash'
	| 'edit'
	| 'eval'
	| 'glob'
	| 'google'
	| 'grep'
	| 'read'
	| 'read_blob'
	| 'read_url'
	| 'send'
	| 'spawn_agent'
	| 'write'

// ── JSON-schema-lite types for tool definitions ──
// We only model the subset Hal actually emits today.

export interface JsonSchemaProperty {
	type: string
	description?: string
	enum?: string[]
	items?: JsonSchemaProperty
	properties?: JsonSchemaProperties
	required?: string[]
}

export type JsonSchemaProperties = Record<string, JsonSchemaProperty>

export interface ToolInputSchema {
	type: 'object'
	properties: JsonSchemaProperties
	required?: string[]
}

// ── Message types (for API conversation format) ──

export type MessageRole = 'user' | 'assistant'

export interface ContentBlock {
	type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image'
	text?: string
	thinking?: string
	signature?: string
	id?: string // tool_use id
	name?: string // tool_use name
	input?: Record<string, unknown> // tool_use input
	tool_use_id?: string // tool_result reference
	content?: string | Record<string, unknown>[] // tool_result content
}

export interface Message {
	role: MessageRole
	content: string | ContentBlock[]
}

export interface PartialTokenUsage {
	input: number
	output: number
	cacheRead?: number
	cacheCreation?: number
}

export interface TokenUsage {
	input: number
	output: number
	cacheRead: number
	cacheCreation: number
}

// ── Tool definitions (sent to providers) ──

export interface ToolDef {
	name: string
	description: string
	input_schema: ToolInputSchema
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
	input?: Record<string, unknown>
	parseError?: string
	rawJson?: string
	// server_tool fields — opaque content blocks from server-side tools (e.g. web_search).
	// These go into the assistant message content verbatim and need no local execution.
	serverBlocks?: Record<string, unknown>[]
	// status fields
	activity?: string
	// error fields
	message?: string
	status?: number
	body?: string
	endpoint?: string // the URL the request was sent to
	retryAfterMs?: number
	// done fields
	// Token usage breakdown:
	//   input          — uncached input tokens (billed at full rate)
	//   output         — output tokens
	//   cacheRead      — cache-hit tokens (billed at ~10% of input rate)
	//   cacheCreation  — cache-write tokens (billed at ~125% of input rate)
	// Providers without cache tracking (e.g. OpenAI) leave cacheRead/cacheCreation as 0.
	usage?: TokenUsage
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
