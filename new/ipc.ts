// File-backed IPC bus. Host appends events, clients append commands.
// Fixes from old impl: offset-based tailing (no gaps), atomic host lock.

import { open, readFile, writeFile, rename, rm } from 'fs/promises'
import { stringify, parse } from './utils/ason.ts'
import { isPidAlive } from './utils/is-pid-alive.ts'
import { Log } from './utils/log.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState } from './protocol.ts'
import { defaultState } from './protocol.ts'
import { liveFile } from './live-file.ts'
import { IPC_DIR, ensureDir } from './state.ts'

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

// ── Host lock ──

export async function claimHost(hostId: string): Promise<{ host: boolean; currentPid: number | null }> {
	ensureDir(IPC_DIR)
	const payload = stringify({ hostId, pid: process.pid, createdAt: new Date().toISOString() })
	const me = `pid=${process.pid}`

	// Fast path: no lock exists → exclusive create wins atomically
	try {
		const fh = await open(HOST_LOCK, 'wx')
		await fh.writeFile(payload)
		await fh.close()
		updateState(s => { s.hostPid = process.pid; s.hostId = hostId })
		console.error(`[lock] ${me} → host=true (fresh claim)`)
		return { host: true, currentPid: process.pid }
	} catch (e: any) {
		if (e?.code !== 'EEXIST') throw e
		console.error(`[lock] ${me} lock exists, checking owner...`)
	}

	// Lock exists — read and check owner
	let lockHostId: string | null = null
	let lockPid: number | null = null
	try {
		const raw = await readFile(HOST_LOCK, 'utf-8')
		const lock = parse(raw) as any
		lockHostId = lock?.hostId ?? null
		lockPid = Number.isInteger(lock?.pid) ? lock.pid : null
		console.error(`[lock] ${me} read lock: hostId=${lockHostId} lockPid=${lockPid}`)
	} catch (e: any) {
		console.error(`[lock] ${me} readFile FAILED: ${e?.code ?? e?.message}`)
		return { host: false, currentPid: getState().hostPid }
	}

	if (lockHostId === hostId) {
		console.error(`[lock] ${me} → host=true (same hostId)`)
		return { host: true, currentPid: process.pid }
	}
	if (lockPid !== null && isPidAlive(lockPid)) {
		console.error(`[lock] ${me} → host=false (lockPid=${lockPid} alive)`)
		return { host: false, currentPid: lockPid }
	}

	// Dead host — rename our claim over the lock (atomic overwrite,
	// lock file always exists so fresh claimers see EEXIST)
	console.error(`[lock] ${me} dead host (lockPid=${lockPid}), stealing...`)
	const tmp = `${HOST_LOCK}.claim.${process.pid}`
	await writeFile(tmp, payload)
	try {
		await rename(tmp, HOST_LOCK)
	} catch (e: any) {
		console.error(`[lock] ${me} rename FAILED: ${e?.code ?? e?.message}`)
		try { await rm(tmp) } catch {}
		return { host: false, currentPid: getState().hostPid }
	}

	// Multiple stealers may rename concurrently — last rename wins.
	// Verify we own the lock by reading it back after a settle delay.
	await Bun.sleep(30)
	try {
		const raw = await readFile(HOST_LOCK, 'utf-8')
		const lock = parse(raw) as any
		if (lock?.hostId === hostId) {
			updateState(s => { s.hostPid = process.pid; s.hostId = hostId })
			console.error(`[lock] ${me} → host=true (stole lock, verified)`)
			return { host: true, currentPid: process.pid }
		}
		console.error(`[lock] ${me} → host=false (overwritten by ${lock?.hostId})`)
		return { host: false, currentPid: lock?.pid ?? null }
	} catch {
		console.error(`[lock] ${me} → host=false (verify read failed)`)
		return { host: false, currentPid: getState().hostPid }
	}
}

export async function releaseHost(hostId: string): Promise<void> {
	try {
		const raw = await readFile(HOST_LOCK, 'utf-8')
		const lock = parse(raw) as any
		if (lock?.hostId !== hostId) return
		await rm(HOST_LOCK)
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
	} catch {}
}
