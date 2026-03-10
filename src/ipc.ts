// File-backed IPC bus. Host appends events, clients append commands.

import { open, readFile, rename, rm } from 'fs/promises'
import { stringify, parse } from './utils/ason.ts'
import { isPidAlive } from './utils/is-pid-alive.ts'
import { Log } from './utils/log.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState, EventLevel } from './protocol.ts'
import { defaultState, eventId } from './protocol.ts'
import { liveFile } from './utils/live-file.ts'
import { IPC_DIR, ensureDir } from './state.ts'

export const commands = new Log<RuntimeCommand>(`${IPC_DIR}/commands.asonl`)
export const events = new Log<RuntimeEvent>(`${IPC_DIR}/events.asonl`)
const HOST_LOCK = `${IPC_DIR}/host.lock`

let _state: RuntimeState | null = null

export async function ensureBus(): Promise<void> {
	ensureDir(IPC_DIR)
	await commands.ensure()
	await events.ensure()
	getState()
}

export function getState(): RuntimeState {
	if (!_state) {
		ensureDir(IPC_DIR)
		_state = liveFile<RuntimeState>(`${IPC_DIR}/state.ason`, { defaults: defaultState() })
	}
	return _state
}

export function updateState(fn: (s: RuntimeState) => void): void {
	const s = getState() as RuntimeState & { save?: () => void }
	fn(s)
	s.updatedAt = new Date().toISOString()
	s.save?.()
}

async function readLock(): Promise<{ hostId: string | null; pid: number | null } | null> {
	// Retry once on parse failure (file may be mid-write)
	for (let i = 0; i < 2; i++) {
		try {
			const lock = parse(await readFile(HOST_LOCK, 'utf-8')) as any
			return { hostId: lock?.hostId ?? null, pid: Number.isInteger(lock?.pid) ? lock.pid : null }
		} catch { if (i === 0) await Bun.sleep(100) }
	}
	return null
}

export async function claimHost(hostId: string): Promise<{ host: boolean; currentPid: number | null }> {
	ensureDir(IPC_DIR)
	const payload = stringify({ hostId, pid: process.pid, createdAt: new Date().toISOString() })
	const won = () => { updateState(s => { s.hostPid = process.pid; s.hostId = hostId }); return { host: true, currentPid: process.pid } as const }
	const lost = (pid?: number | null) => ({ host: false, currentPid: pid ?? getState().hostPid } as const)

	const tryClaim = async () => {
		try { const fh = await open(HOST_LOCK, 'wx'); await fh.writeFile(payload); await fh.close(); return true }
		catch (e: any) { if (e?.code === 'EEXIST') return false; throw e }
	}

	const stealStaleLock = async () => {
		const stale = `${HOST_LOCK}.stale.${process.pid}`
		try { await rename(HOST_LOCK, stale) } catch { return lost() }
		try { await rm(stale) } catch {}
		return (await tryClaim()) ? won() : lost()
	}

	if (await tryClaim()) return won()
	const lock = await readLock()
	if (!lock) return stealStaleLock()
	if (lock.hostId === hostId) return won()
	if (lock.pid !== null && isPidAlive(lock.pid)) return lost(lock.pid)

	// Dead host — steal stale lock and retry.
	return stealStaleLock()
}

export async function verifyHost(hostId: string): Promise<boolean> {
	try {
		const lock = await readLock()
		return lock?.hostId === hostId
	} catch { return false }
}

export async function releaseHost(hostId: string): Promise<void> {
	try {
		const lock = await readLock()
		if (lock?.hostId !== hostId) return
		await rm(HOST_LOCK)
		updateState(s => { if (s.hostId === hostId) { s.hostPid = null; s.hostId = null; s.busySessionIds = [] } })
		await events.append({ id: `${Date.now()}-${process.pid}-release`, type: 'line', sessionId: null, text: '[host-released]', level: 'meta', createdAt: new Date().toISOString() } as RuntimeEvent)
	} catch {}
}

/** Emit a line to the TUI without persisting to session history. */
export function log(text: string, sessionId?: string | null, level: EventLevel = 'info'): Promise<void> {
	return events.append({ id: eventId(), type: 'line', sessionId: sessionId ?? null, text, level, createdAt: new Date().toISOString() } as RuntimeEvent)
}

export const ipc = {
	ensureBus,
	getState,
	updateState,
	claimHost,
	verifyHost,
	releaseHost,
	log,
	commands,
	events,
}