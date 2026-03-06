// File-backed IPC bus. Host appends events, clients append commands.
// Fixes from old impl: offset-based tailing (no gaps), atomic host lock.

import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { stringify, parse, parseAll, parseStream } from './utils/ason.ts'
import { isPidAlive } from './utils/is-pid-alive.ts'
import { tailFile } from './utils/tail-file.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimeState } from './protocol.ts'
import { defaultState } from './protocol.ts'
import { IPC_DIR, ensureDir } from './state.ts'

// ── Paths ──

const COMMANDS_FILE = `${IPC_DIR}/commands.asonl`
const EVENTS_FILE = `${IPC_DIR}/events.asonl`
const STATE_FILE = `${IPC_DIR}/state.ason`
const HOST_LOCK = `${IPC_DIR}/host.lock`

// ── Init ──

export async function ensureBus(): Promise<void> {
	ensureDir(IPC_DIR)
	for (const f of [COMMANDS_FILE, EVENTS_FILE]) {
		if (!existsSync(f)) await writeFile(f, '')
	}
	if (!existsSync(STATE_FILE)) await writeState(defaultState())
}

// ── State ──

let stateWriteLock = Promise.resolve()

export async function readState(): Promise<RuntimeState> {
	try {
		const raw = await readFile(STATE_FILE, 'utf-8')
		return { ...defaultState(), ...(parse(raw) as Record<string, unknown>) }
	} catch {
		const s = defaultState()
		await writeState(s)
		return s
	}
}

export async function writeState(s: RuntimeState): Promise<void> {
	const doWrite = async () => {
		s.updatedAt = new Date().toISOString()
		const tmp = `${STATE_FILE}.tmp.${process.pid}`
		await writeFile(tmp, stringify(s) + '\n')
		await rename(tmp, STATE_FILE)
	}
	stateWriteLock = stateWriteLock.then(doWrite, doWrite)
	await stateWriteLock
}

export async function updateState(fn: (s: RuntimeState) => void): Promise<RuntimeState> {
	const s = await readState()
	fn(s)
	await writeState(s)
	return s
}

// ── Host lock ──

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
		await updateState(s => { s.hostPid = process.pid; s.hostId = hostId })
		return { host: true, currentPid: process.pid }
	}

	// Lock exists — check owner
	let lockHostId: string | null = null
	let lockPid: number | null = null
	try {
		const raw = await readFile(HOST_LOCK, 'utf-8')
		const lock = parse(raw) as any
		lockHostId = lock?.hostId ?? null
		lockPid = Number.isInteger(lock?.pid) ? lock.pid : null
	} catch {
		lockPid = null
	}

	if (lockHostId === hostId) return { host: true, currentPid: process.pid }
	if (lockPid !== null && isPidAlive(lockPid)) return { host: false, currentPid: lockPid }

	// Dead host — steal lock atomically
	const stale = `${HOST_LOCK}.stale.${process.pid}`
	try { await rename(HOST_LOCK, stale) } catch {
		return { host: false, currentPid: (await readState()).hostPid }
	}
	try { await rm(stale) } catch {}

	if (await tryClaim()) {
		await updateState(s => { s.hostPid = process.pid; s.hostId = hostId })
		return { host: true, currentPid: process.pid }
	}
	return { host: false, currentPid: (await readState()).hostPid }
}

export async function releaseHost(hostId: string): Promise<void> {
	try {
		const raw = await readFile(HOST_LOCK, 'utf-8')
		const lock = parse(raw) as any
		if (lock?.hostId !== hostId) return
		await rm(HOST_LOCK)
		await updateState(s => {
			if (s.hostId === hostId) {
				s.hostPid = null
				s.hostId = null
				s.busySessionIds = []
			}
		})
		await appendEvent({
			id: `${Date.now()}-${process.pid}-release`,
			type: 'line', sessionId: null,
			text: '[owner-released]', level: 'meta',
			createdAt: new Date().toISOString(),
		} as RuntimeEvent)
	} catch {}
}

// ── Commands ──

export async function appendCommand(cmd: RuntimeCommand): Promise<void> {
	await appendFile(COMMANDS_FILE, stringify(cmd, 'short') + '\n')
}

/** Tail commands from a byte offset. Returns current offset, generator, and cancel function. */
export async function tailCommandsFrom(fromOffset?: number): Promise<{
	offset: number
	commands: AsyncGenerator<RuntimeCommand>
	cancel(): void
}> {
	const offset = fromOffset ?? await fileSize(COMMANDS_FILE)
	const stream = tailFile(COMMANDS_FILE, offset)
	const reader = stream.getReader()
	let cancelled = false
	const cancel = () => { cancelled = true; reader.cancel() }
	const wrapped = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (cancelled) { controller.close(); return }
			const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }))
			done ? controller.close() : controller.enqueue(value)
		},
	})
	return {
		offset,
		commands: parseStream(wrapped) as AsyncGenerator<RuntimeCommand>,
		cancel,
	}
}

// ── Events ──

export async function appendEvent(event: RuntimeEvent): Promise<void> {
	await appendFile(EVENTS_FILE, stringify(event, 'short') + '\n')
}

/** Read events from a byte offset. Returns events + new offset (for gap-free tailing). */
export async function readEventsFrom(fromOffset: number): Promise<{
	events: RuntimeEvent[]
	offset: number
}> {
	const buf = await readFile(EVENTS_FILE)
	if (fromOffset >= buf.length) return { events: [], offset: buf.length }
	const slice = buf.subarray(fromOffset).toString('utf-8')
	// Only parse complete lines — skip partial trailing data
	const lastNewline = slice.lastIndexOf('\n')
	if (lastNewline < 0) return { events: [], offset: fromOffset }
	const complete = slice.slice(0, lastNewline + 1)
	const events: RuntimeEvent[] = []
	for (const line of complete.split('\n')) {
		if (!line.trim()) continue
		try { events.push(parse(line) as RuntimeEvent) }
		catch { /* skip corrupt/partial lines */ }
	}
	const bytesConsumed = Buffer.byteLength(complete, 'utf-8')
	return { events, offset: fromOffset + bytesConsumed }
}

/** Tail events from a byte offset. Gap-free: pass the offset from readEventsFrom or bootstrap. */
export function tailEventsFrom(fromOffset: number): AsyncGenerator<RuntimeEvent> {
	return parseStream(tailFile(EVENTS_FILE, fromOffset)) as AsyncGenerator<RuntimeEvent>
}

/** Current byte size of the events file (for bootstrap offset). */
export async function eventsOffset(): Promise<number> {
	return fileSize(EVENTS_FILE)
}

/** Trim events file to last N entries (called on host startup). */
export async function trimEvents(keep = 500): Promise<void> {
	const raw = await readFile(EVENTS_FILE, 'utf-8').catch(() => '')
	const all = parseAll(raw) as RuntimeEvent[]
	if (all.length <= keep) return
	const kept = all.slice(-keep).map(e => stringify(e, 'short')).join('\n') + '\n'
	await writeFile(EVENTS_FILE, kept)
}

// ── Helpers ──

async function fileSize(path: string): Promise<number> {
	try {
		const s = await stat(path)
		return s.size
	} catch {
		return 0
	}
}
