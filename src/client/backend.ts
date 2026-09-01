import type { HistoryEntry } from '../common/history.ts'
import type { LiveBlock } from '../common/live-event-blocks.ts'
import type { SessionMeta } from '../common/session.ts'
import { resolve } from 'path'
import { tmpdir } from 'os'

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
	onChange: (callback: () => void) => void
}

function unavailable(): never {
	throw new Error('Client backend is not installed')
}

const defaultHalDir = process.env.HAL_DIR ?? resolve(import.meta.dir, '../..')
const paths = {
	halDir: defaultHalDir,
	stateDir: process.env.HAL_STATE_DIR ?? (process.env.NODE_ENV === 'test' ? `${tmpdir()}/hal-test-state-${process.pid}` : `${defaultHalDir}/state`),
}

const sessions: SessionBackend = {
	sessionDir: (sessionId) => `${paths.stateDir}/sessions/${sessionId}`,
	loadAllSessionMetas: unavailable,
	loadSessionMeta: unavailable,
	loadHistoryLog: unavailable,
	loadAllHistoryWithOrigin: unavailable,
	loadLive: unavailable,
}

const subscriptions: SubscriptionBackend = {
	isApiKey: () => false,
	current: () => null,
	onChange: () => {},
}

const state = { installed: false }

function install(backend: { paths?: Partial<typeof paths>; sessions?: Partial<SessionBackend>; subscriptions?: Partial<SubscriptionBackend> }): void {
	if (backend.paths) Object.assign(paths, backend.paths)
	if (backend.sessions) Object.assign(sessions, backend.sessions)
	if (backend.subscriptions) Object.assign(subscriptions, backend.subscriptions)
	state.installed = true
}

export const clientBackend = { state, paths, sessions, subscriptions, install }
