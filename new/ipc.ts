// File-backed IPC bus. Host appends events, clients append commands.
// Host lock uses flock() for correct mutual exclusion.

import { openSync, closeSync, writeFileSync } from 'fs'
import { dlopen, FFIType } from 'bun:ffi'
import { stringify, parse } from './utils/ason.ts'
import { Log } from './utils/log.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState } from './protocol.ts'
import { defaultState } from './protocol.ts'
import { liveFile } from './live-file.ts'
import { IPC_DIR, ensureDir } from './state.ts'

// flock constants
const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8
const libc = dlopen('libSystem.B.dylib', {
	flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})
// ── Logs ──

export const commands = new Log<RuntimeCommand>(`${IPC_DIR}/commands.asonl`)
export const events = new Log<RuntimeEvent>(`${IPC_DIR}/events.asonl`)

const HOST_LOCK = `${IPC_DIR}/host.lock`

// ── Init ──

export async function ensureBus(): Promise<void> {
	ensureDir(IPC_DIR)
	await commands.ensure()
	await events.ensure()
	getState()
}

// ── State (liveFile-backed) ──

let _state: RuntimeState | null = null

export function getState(): RuntimeState {
	if (!_state) {
		ensureDir(IPC_DIR)
		_state = liveFile<RuntimeState>(`${IPC_DIR}/state.ason`, { defaults: defaultState() })
	}
	return _state
}

export function updateState(fn: (s: RuntimeState) => void): void {
	const s = getState()
	fn(s)
	s.updatedAt = new Date().toISOString()
}

// ── Host lock (flock-based) ──

let lockFd: number | null = null

export function claimHost(hostId: string): { host: boolean; currentPid: number | null } {
	ensureDir(IPC_DIR)
	const me = `pid=${process.pid}`

	// Open or create lock file, then try non-blocking exclusive flock
	const fd = openSync(HOST_LOCK, 'a+')
	if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
		closeSync(fd)
		// Lock held by another process — read to get their PID
		let currentPid: number | null = null
		try {
			const raw = Bun.file(HOST_LOCK).textSync()
			const lock = parse(raw) as any
			currentPid = Number.isInteger(lock?.pid) ? lock.pid : null
		} catch {}
		console.error(`[lock] ${me} → host=false (flock held by pid=${currentPid})`)
		return { host: false, currentPid }
	}

	// We hold the flock — write our info
	lockFd = fd
	writeFileSync(HOST_LOCK, stringify({ hostId, pid: process.pid, createdAt: new Date().toISOString() }))
	updateState(s => { s.hostPid = process.pid; s.hostId = hostId })
	console.error(`[lock] ${me} → host=true (flock acquired)`)
	return { host: true, currentPid: process.pid }
}

export async function releaseHost(hostId: string): Promise<void> {
	if (lockFd !== null) {
		libc.symbols.flock(lockFd, LOCK_UN)
		closeSync(lockFd)
		lockFd = null
	}
	updateState(s => {
		if (s.hostId === hostId) {
			s.hostPid = null
			s.hostId = null
			s.busySessionIds = []
		}
	})
	await events.append({
		id: `${Date.now()}-${process.pid}-release`,
		type: 'line', sessionId: null,
		text: '[host-released]', level: 'meta',
		createdAt: new Date().toISOString(),
	} as RuntimeEvent)
}
