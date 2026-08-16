import type { PartialTokenUsage, TurnEndMeta } from './protocol.ts'

// Browser-safe persisted history contract. Server persistence owns how entries
// are stored; clients and deterministic projections only depend on this shape.
export type UserPart =
	| { type: 'text'; text: string; displayText?: string }
	| { type: 'image'; blobId: string; originalFile?: string }

export type EntryIdentity = { id?: string; canceled?: true }

export type HistoryEntry = EntryIdentity & (
	| { type: 'user'; parts: UserPart[]; text?: never; source?: string; sourceTab?: number; status?: string; ts?: string }
	| {
			type: 'thinking'
			text?: string
			blobId?: string
			signature?: string
			model?: string
			thinkingEffort?: string
			ts?: string
		}
	| {
			type: 'assistant'
			text: string
			model?: string
			usage?: PartialTokenUsage
			synthetic?: boolean
			syntheticKind?: string
			visibility?: 'ui'
			ts?: string
		}
	| { type: 'tool_call'; toolId: string; name: string; input?: any; blobId?: string; visibility?: 'ui'; ts?: string }
	| { type: 'tool_result'; toolId: string; output?: any; blobId?: string; isError?: boolean; visibility?: 'ui'; ts?: string }
	| { type: 'pending_tools'; toolIds: string[]; cwd: string; model?: string; usage?: PartialTokenUsage; reason?: 'soft-pause'; ts?: string }
	| ({ type: 'turn_end'; ts?: string } & TurnEndMeta)
	| { type: 'log'; text: string; level?: 'info' | 'warning' | 'error'; retryable?: false; usageBars?: true; visibility?: 'ui' | 'next-user'; ts?: string }
	| { type: 'info'; text: string; level?: 'info' | 'warning' | 'error'; usageBars?: true; visibility?: 'ui' | 'next-user'; ui?: 'notice'; ts?: string }
	| { type: 'warning' | 'error'; text: string; blobId?: string; visibility?: 'ui' | 'next-user'; ts?: string }
	| { type: 'reset' | 'compact'; ts?: string }
	| { type: 'forked_from'; parent: string; ts?: string }
	| { type: 'forked_to'; child: string; ts?: string }
	| { type: 'rebased_from'; log: string; ts?: string }
	| { type: 'rebased_to'; log: string; ts?: string }
	| { type: 'cwd'; from: string; to: string; visibility?: 'next-user'; ts?: string }
	| { type: 'model'; from: string; to: string; visibility?: 'next-user'; ts?: string }
	| { type: 'input_history'; text: string; ts?: string }
)
