// Session history records (one per line in sessions/<id>/history.asonl)
// and the rebuild of provider input from them. Provider input comes from
// these records alone, never from display state.

import type { AssistantBlock, Message, StopReason, ToolResultBlock, Usage, UserBlock } from './blocks.ts'

export type TurnStatus = 'completed' | 'cancelled' | 'error' | 'interrupted'

export type HistoryRecord =
	// A submitted prompt, or tool results.
	| { type: 'user'; blocks: UserBlock[]; ts: string }
	// One assistant block, appended as soon as it is complete.
	| { type: 'assistant'; block: AssistantBlock; ts: string }
	// Ends one model turn. `interrupted`: the host died mid-turn.
	| { type: 'turn_end'; status: TurnStatus; reason?: StopReason; error?: string; usage: Usage; ts: string }

// Provider messages from history. Unsigned thinking (a cut-off stream) is
// not replayable and is left out. Each tool call gets a result before the
// next user message: a missing one becomes an error result, and results
// with no call are dropped, so the input stays valid for every provider.
function toMessages(records: HistoryRecord[]): Message[] {
	let out: Message[] = []
	let pending: string[] = []
	let status: TurnStatus | undefined
	let push = (msg: Message) => {
		let last = out.at(-1)
		if (last?.role === msg.role) (last.blocks as unknown[]).push(...msg.blocks)
		else if (msg.blocks.length) out.push(msg)
	}
	for (let r of records) {
		if (r.type === 'turn_end') status = r.status
		else if (r.type === 'assistant') {
			let b = r.block
			if (b.type === 'thinking' && !b.signature) continue
			if (b.type === 'tool_call') pending.push(b.id)
			push({ role: 'assistant', blocks: [{ ...b }] })
		} else {
			let results = r.blocks.filter((b): b is ToolResultBlock => b.type === 'tool_result' && pending.includes(b.id))
			let answered = new Set(results.map((b) => b.id))
			let missing: ToolResultBlock[] = pending
				.filter((id) => !answered.has(id))
				.map((id) => ({ type: 'tool_result', id, output: `Tool call did not run: the turn ${status ?? 'ended'}.`, isError: true }))
			pending = []
			push({ role: 'user', blocks: [...results, ...missing, ...r.blocks.filter((b) => b.type !== 'tool_result')] })
		}
	}
	return out
}

// True if the last turn has not ended: something follows the last turn end.
function openTurn(records: HistoryRecord[]): boolean {
	let last = records.at(-1)
	return last !== undefined && last.type !== 'turn_end'
}

export const replay = { toMessages, openTurn }
