import { mkdirSync, readFileSync } from 'fs'
import { STATE_DIR, ensureDir } from '../../state.ts'
import { liveFiles } from '../../utils/live-file.ts'

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const MAX_ATTEMPTS = 1000
const MS_PER_DAY = 86_400_000
const WORDS_PATH = `${import.meta.dir}/words3.txt`

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

function randomChars(): string {
	let suffix = ''
	for (let i = 0; i < 3; i++) suffix += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
	return suffix
}

// Picks a three-character session suffix from words3.txt. That file is
// fixed-width: each candidate is exactly 3 chars followed by a space or newline.
function randomWord(): string {
	const words = readFileSync(WORDS_PATH, 'utf-8')
	const pos = Math.floor(Math.random() * (words.length / 4)) * 4
	const word = words.slice(pos, pos + 3)
	if (!/^[a-z0-9]{3}$/.test(word)) throw new Error(`Invalid session word at offset ${pos}`)
	return word
}

function make(date = new Date(Date.now()), epochMs = readOrCreateEpochMs(date.getTime()), suffix = randomWord()): string {
	const days = String(Math.max(0, Math.floor((date.getTime() - epochMs) / MS_PER_DAY))).padStart(2, '0')
	return `${days}-${suffix}`
}

function claim(sessionId: string): boolean {
	try {
		// mkdir without recursive acts as the reservation. If another process has
		// already claimed this ID, the kernel returns EEXIST and we retry.
		mkdirSync(sessionDir(sessionId))
		return true
	} catch (err: any) {
		if (err?.code === 'EEXIST') return false
		throw err
	}
}

function reserve(): string {
	ensureDir(sessionsDir())
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const sessionId = make()
		if (claim(sessionId)) return sessionId
	}
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const sessionId = make(undefined, undefined, randomChars())
		if (claim(sessionId)) return sessionId
	}
	throw new Error(`Failed to reserve unique session ID after ${MAX_ATTEMPTS} attempts`)
}

export const sessionIds = { make, randomWord, reserve, sessionDir, sessionsDir }
