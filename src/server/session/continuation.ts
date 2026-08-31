import type { HistoryEntry } from '../../common/history.ts'
import type { ContinuationAction } from '../../common/ipc.ts'
import type { Message } from '../../common/protocol.ts'

// This is the sole history-to-action projection. The server publishes its result
// to clients and checks the same result before accepting an empty prompt.
function actionForHistory(entries: HistoryEntry[]): ContinuationAction | false {
	if (entries.some((entry) => entry.type === 'pending_tools' && !entry.canceled)) return 'continue'
	let contentAfterCompleted = false
	let outcome: 'failed' | 'aborted' | undefined
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!
		if (entry.canceled) continue
		if (entry.type === 'turn_end') {
			if (entry.status === 'completed') break
			outcome ??= entry.status
			continue
		}
		if ((entry.type === 'assistant' || entry.type === 'tool_call' || entry.type === 'tool_result') && entry.visibility === 'ui') continue
		if (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'thinking' || entry.type === 'tool_call' || entry.type === 'tool_result') contentAfterCompleted = true
	}
	if (!contentAfterCompleted) return false
	if (outcome === 'failed') return 'retry'
	return 'continue'
}

function prepareMessages(messages: Message[], action: ContinuationAction): void {
	if (messages.at(-1)?.role === 'assistant') {
		messages.push({ role: 'user', content: '<meta>The previous response was interrupted. Continue without repeating completed work.</meta>' })
		return
	}
	if (action === 'retry') messages.push({ role: 'user', content: '<meta>The previous attempt failed before producing a usable response. Retry the last user request.</meta>' })
}

export const continuation = { actionForHistory, prepareMessages }
