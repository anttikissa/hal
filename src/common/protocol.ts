// IPC protocol types — commands, events, shared types.
import type { AnswerValue } from './history.ts'
//
// Defines the contract between client and server. Commands flow client→server,
// events flow server→client. Both are serialized to ASONL files via ipc.ts.

// Keep shared status values in this browser-safe contract. Runtime code may
// implement version discovery, but clients only need its serialized state.
export type VersionStatus = 'idle' | 'pending' | 'ready' | 'error'

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
	| 'history-updated'
	| 'rebase-start'
	| 'rebase-result'
	| 'history-rebased'
	| 'background-activity'
	| 'draft_saved'

// ── Command types (client → server) ──

export type CommandType = 'prompt' | 'prompt-amend' | 'continue' | 'run-next-from-queue' | 'pause-before-tools' | 'open' | 'close' | 'resume' | 'abort' | 'answer' | 'reset' | 'compact' | 'rebase-start' | 'rebase-apply' | 'move' | 'spawn' | 'focus' | 'what' | 'draft-saved' | 'client-status' | 'client-exit'

export type SpawnMode = 'fork' | 'fresh'
export type SpawnKind = 'subagent' | 'subagent-leave-open' | 'interactive'

// Commands are stored directly in commands.asonl. Keep them structured and
// explicit so the log stays readable; never smuggle another serialized object
// through a generic text field.
export interface CommandBase {
	sessionId?: string
	createdAt?: string
}


export interface PromptCommand extends CommandBase {
	type: 'prompt'
	id?: string
	text: string
	displayText?: string
	queue?: boolean
	source?: string
	sourceTab?: number
}

export interface PromptAmendCommand extends CommandBase {
	type: 'prompt-amend'
	text: string
	displayText?: string
	source?: string
}

export interface ContinueCommand extends CommandBase {
	type: 'continue'
}

export interface RunNextFromQueueCommand extends CommandBase {
	type: 'run-next-from-queue'
}

export interface PauseBeforeToolsCommand extends CommandBase {
	type: 'pause-before-tools'
}

export interface OpenNewCommand extends CommandBase {
	type: 'open'
	// A same-machine peer can request a tab for its shell directory. The active
	// server process may have a different cwd, so the peer sends its path explicitly.
	cwd?: string
	// Slash commands such as /self need a genuinely new tab even when another open
	// session has this cwd. Peer startup leaves this false and reuses the first open
	// match; dormant sessions are resumed only by an explicit resume operation.
	forceNew?: boolean
}
export interface OpenForkCommand extends CommandBase {
	type: 'open'
	forkSessionId: string
	// Optional cwd override for fork variants such as /self --fork.
	cwd?: string
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
	abortText?: string
}

export interface ResetCommand extends CommandBase {
	type: 'reset'
}

export interface CompactCommand extends CommandBase {
	type: 'compact'
}

export interface RebaseStartCommand extends CommandBase {
	type: 'rebase-start'
	requestId: string
	clientPid: number
}

export interface RebaseApplyCommand extends CommandBase {
	type: 'rebase-apply'
	requestId: string
	clientPid: number
	todo: string
	edits?: Record<string, string>
}

export interface MoveCommand extends CommandBase {
	type: 'move'
	position: number
}

export interface SpawnCommandData {
	task: string
	kind: SpawnKind
	mode: SpawnMode
	model?: string
	cwd?: string
	name?: string
	childSessionId?: string
	subagentLimit?: number
}

export interface SpawnCommand extends CommandBase {
	type: 'spawn'
	spawn: SpawnCommandData
}

export interface AnswerCommand extends CommandBase {
	type: 'answer'
	questionId: string
	value: AnswerValue
}

export interface FocusCommand extends CommandBase {
	type: 'focus'
}

export interface WhatCommand extends CommandBase {
	type: 'what'
	target?: string
}

export interface DraftSavedCommand extends CommandBase {
	type: 'draft-saved'
}
export interface ClientStatusCommand extends CommandBase {
	type: 'client-status'
	pid: number
	startedAt: string
	updatedAt: string
	cwd?: string
	versionStatus: VersionStatus
	version?: string
	error?: string
}

export interface ClientExitCommand extends CommandBase {
	type: 'client-exit'
	pid: number
}

export type Command =
	| PromptCommand
	| PromptAmendCommand
	| ClientStatusCommand
	| ClientExitCommand
	| ContinueCommand
	| RunNextFromQueueCommand
	| PauseBeforeToolsCommand
	| OpenNewCommand
	| OpenForkCommand
	| OpenAfterCommand
	| CloseCommand
	| ResumeCommand
	| AbortCommand
	| ResetCommand
	| CompactCommand
	| RebaseStartCommand
	| RebaseApplyCommand
	| MoveCommand
	| SpawnCommand
	| AnswerCommand
	| FocusCommand
	| WhatCommand
	| DraftSavedCommand

// ── Tool call types ──

export type ToolName =
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
	content?: string | ContentBlock[] // tool_result content
	source?: { type: 'base64'; media_type: string; data: string } // image source
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

export type TurnEndStatus = 'completed' | 'failed' | 'aborted'

export interface TurnEndMeta {
	status: TurnEndStatus
	usage?: PartialTokenUsage
	abortText?: string
	/** Provider failure provenance used to resume a 401 after login. */
	provider?: string
	httpStatus?: number
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
	type: 'text' | 'thinking' | 'thinking_signature' | 'tool_call' | 'server_tool' | 'pause' | 'config' | 'error' | 'done'
	text?: string
	key?: string
	value?: string
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
	doneStatus?: TurnEndStatus
}

export interface ProviderRequest {
	messages: Message[]
	model: string
	systemPrompt: string
	tools: ToolDef[]
	signal?: AbortSignal
	sessionId?: string
	stateless?: boolean
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
