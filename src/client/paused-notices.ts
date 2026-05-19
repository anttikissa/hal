import type { Block } from '../cli/blocks.ts'

type PausedBlock = Extract<Block, { type: 'info' }>
type DelayedPausedNotice = { timer: ReturnType<typeof setTimeout>; block: PausedBlock }

const state = { notices: new Map<string, DelayedPausedNotice>() }

function key(sessionId: string | null): string {
	return sessionId ?? ''
}

function cancel(sessionId: string | null): void {
	const pending = state.notices.get(key(sessionId))
	if (!pending) return
	clearTimeout(pending.timer)
	state.notices.delete(key(sessionId))
}

function flush(sessionId: string | null, add: (block: PausedBlock) => void): void {
	const noticeKey = key(sessionId)
	const pending = state.notices.get(noticeKey)
	if (!pending) return
	clearTimeout(pending.timer)
	state.notices.delete(noticeKey)
	add(pending.block)
}

function schedule(sessionId: string | null, block: PausedBlock, delayMs: number, add: (block: PausedBlock) => void): void {
	cancel(sessionId)
	if (delayMs <= 0) {
		add(block)
		return
	}
	const noticeKey = key(sessionId)
	const timer = setTimeout(() => {
		state.notices.delete(noticeKey)
		add(block)
	}, delayMs)
	state.notices.set(noticeKey, { timer, block })
}

function reset(): void {
	for (const pending of state.notices.values()) clearTimeout(pending.timer)
	state.notices = new Map()
}

export const pausedNotices = { state, cancel, flush, schedule, reset }
