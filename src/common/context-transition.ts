// Durable context-change intent, carried by command output (task jf).
import type { Sender } from './blocks.ts'
import type { HistoryRecord } from './replay.ts'

export type ContextTransition = { id: string; kind: 'clear' | 'compact'; prompt?: string; sender: Sender; canceled?: true }

function pending(records: HistoryRecord[]): ContextTransition | undefined {
	let intent: ContextTransition | undefined
	for (let r of records) {
		if (r.type !== 'output') continue
		if (r.transition) intent = { ...r.transition }
		if (intent && r.transitionCancel === intent.id) intent.canceled = true
		if (intent && r.transitionDone === intent.id) intent = undefined
	}
	return intent
}

export const contextTransition = { pending }
