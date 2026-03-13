import type { Message } from '../session/history.ts'

type StartupTraceKey =
	| 'first-code'
	| 'rt-ipc-ready'
	| 'rt-state-loaded'
	| 'rt-sessions-restored'
	| 'rt-published'
	| 'rt-handoff-done'
	| 'rt-tail-started'
	| 'runtime-ready'
	| 'cli-ready'
	| 'active-messages-loaded'
	| 'active-tail-hydrated'
	| 'active-tail-rendered'
	| 'interactive-ready'
	| 'active-all-hydrated'
	| 'other-tabs-hydrated'

interface StartupTraceMark {
	atMs: number
	detail?: string
}

interface StartupTraceState {
	epochMs: number | null
	marks: Partial<Record<StartupTraceKey, StartupTraceMark>>
	emitted: Partial<Record<StartupTraceKey, true>>
	lastEmittedAtMs: number | null
}

const startupTraceOrder: Record<StartupTraceKey, number> = {
	'first-code': 0,
	'rt-ipc-ready': 1,
	'rt-state-loaded': 2,
	'rt-sessions-restored': 3,
	'rt-published': 4,
	'rt-handoff-done': 5,
	'rt-tail-started': 6,
	'runtime-ready': 7,
	'cli-ready': 8,
	'active-messages-loaded': 9,
	'active-tail-hydrated': 10,
	'active-tail-rendered': 11,
	'interactive-ready': 12,
	'active-all-hydrated': 13,
	'other-tabs-hydrated': 14,
}

const startupTraceLabel: Record<StartupTraceKey, string> = {
	'first-code': 'first line of code executed',
	'rt-ipc-ready': 'ipc bus ready',
	'rt-state-loaded': 'state loaded',
	'rt-sessions-restored': 'sessions restored',
	'rt-published': 'state published',
	'rt-handoff-done': 'handoff done',
	'rt-tail-started': 'command tail started',
	'runtime-ready': 'runtime initialized',
	'cli-ready': 'cli initialized',
	'active-messages-loaded': 'current tab messages loaded',
	'active-tail-hydrated': 'current tab tail hydrated',
	'active-tail-rendered': 'current tab tail rendered',
	'interactive-ready': 'interactive',
	'active-all-hydrated': 'current tab fully hydrated',
	'other-tabs-hydrated': 'other tabs hydrated',
}

function getGlobalState(): StartupTraceState {
	const root = globalThis as any
	if (!root.__halStartupTrace) {
		root.__halStartupTrace = {
			epochMs: null,
			marks: {},
			emitted: {},
			lastEmittedAtMs: null,
		} as StartupTraceState
	}
	const state = root.__halStartupTrace as StartupTraceState
	if (state.epochMs === null) {
		const meta = root.__hal as { startupEpochMs?: number | null } | undefined
		const epochRaw = meta?.startupEpochMs ?? Number(process.env.HAL_STARTUP_EPOCH_MS)
		state.epochMs = typeof epochRaw === 'number' && Number.isFinite(epochRaw) && epochRaw > 0 ? epochRaw : null
	}
	return state
}

function elapsedNowMs(state: StartupTraceState): number | null {
	if (state.epochMs === null) return null
	return Math.max(0, Math.round(Date.now() - state.epochMs))
}

function sanitizeElapsedMs(atMs: number): number {
	if (!Number.isFinite(atMs)) return 0
	return Math.max(0, Math.round(atMs))
}

function formatLine(key: StartupTraceKey, mark: StartupTraceMark, previousAtMs: number | null): string {
	const delta = previousAtMs === null ? null : Math.max(0, mark.atMs - previousAtMs)
	const deltaText = delta === null ? '' : ` (+${delta}ms)`
	const detailText = mark.detail ? `; ${mark.detail}` : ''
	return `[perf] t+${mark.atMs}ms ${startupTraceLabel[key]}${deltaText}${detailText}`
}

function collectBlobRefs(messages: Message[]): Set<string> {
	const refs = new Set<string>()
	for (const message of messages) {
		if ('role' in message) {
			if (message.role === 'assistant') {
				if (message.thinkingBlobId) refs.add(message.thinkingBlobId)
				for (const tool of message.tools ?? []) refs.add(tool.blobId)
				continue
			}
			if (message.role === 'tool_result') {
				refs.add(message.blobId)
				continue
			}
			if (message.role === 'user' && Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part.type === 'image') refs.add(part.blobId)
				}
			}
		}
	}
	return refs
}

function summarizeMessages(messages: Message[]): string {
	const messageCount = messages.length
	const blobRefCount = collectBlobRefs(messages).size
	return `${messageCount} messages, ${blobRefCount} blob refs`
}

function markAt(key: StartupTraceKey, atMs: number, detail?: string): void {
	const state = getGlobalState()
	state.marks[key] = { atMs: sanitizeElapsedMs(atMs), detail }
}

function mark(key: StartupTraceKey, detail?: string): number | null {
	const state = getGlobalState()
	const atMs = elapsedNowMs(state)
	if (atMs === null) return null
	state.marks[key] = { atMs, detail }
	return atMs
}

function drainLines(): string[] {
	const state = getGlobalState()
	const pending = Object.entries(state.marks)
		.filter(([key]) => !state.emitted[key as StartupTraceKey])
		.map(([key, mark]) => ({ key: key as StartupTraceKey, mark: mark as StartupTraceMark }))
		.sort((a, b) => {
			if (a.mark.atMs !== b.mark.atMs) return a.mark.atMs - b.mark.atMs
			return startupTraceOrder[a.key] - startupTraceOrder[b.key]
		})
	if (pending.length === 0) return []
	const lines: string[] = []
	let previousAtMs = state.lastEmittedAtMs
	for (const item of pending) {
		lines.push(formatLine(item.key, item.mark, previousAtMs))
		state.emitted[item.key] = true
		previousAtMs = item.mark.atMs
	}
	state.lastEmittedAtMs = previousAtMs
	return lines
}

function resetForTests(): void {
	const root = globalThis as any
	delete root.__halStartupTrace
}

export const startupTrace = {
	mark,
	markAt,
	drainLines,
	summarizeMessages,
	resetForTests,
}
