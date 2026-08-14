import type { HistoryEntry } from '../common/history.ts'
import type { LiveBlock } from '../common/live-event-blocks.ts'
import type { SessionMeta } from '../common/session.ts'
import { STATE_DIR } from '../state.ts'

export interface SubscriptionStatus {
	index?: number
	total?: number
	windows: Array<{ label: string; usedPercent: number }>
}

interface SessionBackend {
	sessionDir: (sessionId: string) => string
	loadAllSessionMetas: () => SessionMeta[]
	loadSessionMeta: (sessionId: string) => SessionMeta | null
	loadHistoryLog: (sessionId: string, logName?: string, limit?: number) => HistoryEntry[]
	loadAllHistoryWithOrigin: (sessionId: string) => { entries: HistoryEntry[]; parentCount: number; parentId?: string }
	loadLive: (sessionId: string) => { blocks: LiveBlock[] }
}

interface SubscriptionBackend {
	isApiKey: (provider: string) => boolean
	current: (provider: string) => SubscriptionStatus | null
	noteActivity: () => void
	onChange: (callback: () => void) => void
}

function unavailable(): never {
	throw new Error('Client backend is not installed')
}

const sessions: SessionBackend = {
	sessionDir: (sessionId) => `${STATE_DIR}/sessions/${sessionId}`,
	loadAllSessionMetas: unavailable,
	loadSessionMeta: unavailable,
	loadHistoryLog: unavailable,
	loadAllHistoryWithOrigin: unavailable,
	loadLive: unavailable,
}

const subscriptions: SubscriptionBackend = {
	isApiKey: () => false,
	current: () => null,
	noteActivity: () => {},
	onChange: () => {},
}

const state = { installed: false }

function install(backend: { sessions?: Partial<SessionBackend>; subscriptions?: Partial<SubscriptionBackend> }): void {
	if (backend.sessions) Object.assign(sessions, backend.sessions)
	if (backend.subscriptions) Object.assign(subscriptions, backend.subscriptions)
	state.installed = true
}

export const clientBackend = { state, sessions, subscriptions, install }
