import { mkdirSync } from 'fs'
import { STATE_DIR, ensureDir } from '../state.ts'
import { liveFiles } from '../utils/live-file.ts'

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const DEFAULT_MAX_ATTEMPTS = 1000
const MS_PER_DAY = 86_400_000

interface StateMeta {
	epoch?: string
}

function stateDir(): string {
	// Read the env at call time so tests and multi-state setups can redirect
	// session creation without re-importing this module.
	return process.env.HAL_STATE_DIR ?? STATE_DIR
}

function sessionsDir(): string {
	return `${stateDir()}/sessions`
}

function sessionDir(sessionId: string): string {
	return `${sessionsDir()}/${sessionId}`
}

function readOrCreateEpochMs(now = Date.now()): number {
	ensureDir(stateDir())
	const meta = liveFiles.liveFile<StateMeta>(`${stateDir()}/meta.ason`, {}, { watch: false })
	if (!meta.epoch) {
		meta.epoch = new Date(now).toISOString()
		liveFiles.save(meta)
	}
	return new Date(meta.epoch).getTime()
}

function make(date = new Date(Date.now()), epochMs = readOrCreateEpochMs(date.getTime())): string {
	const days = String(Math.max(0, Math.floor((date.getTime() - epochMs) / MS_PER_DAY))).padStart(2, '0')
	let suffix = ''
	for (let i = 0; i < 3; i++) suffix += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
	return `${days}-${suffix}`
}

function reserve(maxAttempts = DEFAULT_MAX_ATTEMPTS): string {
	ensureDir(sessionsDir())
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const sessionId = make()
		try {
			// mkdir without recursive acts as the reservation. If another process has
			// already claimed this ID, the kernel returns EEXIST and we retry.
			mkdirSync(sessionDir(sessionId))
			return sessionId
		} catch (err: any) {
			if (err?.code === 'EEXIST') continue
			throw err
		}
	}
	throw new Error(`Failed to reserve unique session ID after ${maxAttempts} attempts`)
}

export const sessionIds = { make, reserve, sessionDir, sessionsDir }
