// File-backed IPC bus. Host appends events, clients append commands.

import { open, readFile, rename, rm } from 'fs/promises'
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

async function readLockPid(): Promise<{ hostId: string | null; pid: number | null } | null> {
	for (let i = 0; i < 2; i++) {
		try {
			const raw = await readFile(HOST_LOCK, 'utf-8')
			const lock = parse(raw) as any
			return {
				hostId: lock?.hostId ?? null,
				pid: Number.isInteger(lock?.pid) ? lock.pid : null,
			}
		} catch {
			if (i === 0) await Bun.sleep(100)
		}
	}
	return null
}

export async function claimHost(hostId: string): Promise<{ host: boolean; currentPid: number | null }> {
	ensureDir(IPC_DIR)
	const payload = stringify({ hostId, pid: process.pid, createdAt: new Date().toISOString() })

	const tryClaim = async (): Promise<boolean> => {
		try {
			const fh = await open(HOST_LOCK, 'wx')
			await fh.writeFile(payload)
			await fh.close()
			return true
		} catch (e: any) {
			if (e?.code === 'EEXIST') return false
			throw e
		}
	}

	if (await tryClaim()) {
		updateState(s => { s.hostPid = process.pid; s.hostId = hostId })
		return { host: true, currentPid: process.pid }
	}

	const lock = await readLockPid()
	if (!lock) return { host: false, currentPid: getState().hostPid }
	if (lock.hostId === hostId) return { host: true, currentPid: process.pid }
	if (lock.pid !== null && isPidAlive(lock.pid)) return { host: false, currentPid: lock.pid }

	const stale = `${HOST_LOCK}.stale.${process.pid}`
	try {
		await rename(HOST_LOCK, stale)
	} catch {
		return { host: false, currentPid: getState().hostPid }
	}
	try { await rm(stale) } catch {}

	if (await tryClaim()) {
		updateState(s => { s.hostPid = process.pid; s.hostId = hostId })
		return { host: true, currentPid: process.pid }
	}
	return { host: false, currentPid: getState().hostPid }
}

export async function releaseHost(hostId: string): Promise<void> {
	try {
		const lock = await readLockPid()
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
