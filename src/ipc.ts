// File-backed IPC bus. Host appends events, clients append commands.

import { appendFileSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs'
import { IPC_DIR, ensureDir } from './state.ts'
import { ason } from './utils/ason.ts'
import { tails } from './utils/tail-file.ts'
import { isPidAlive } from './utils/is-pid-alive.ts'

const HOST_LOCK = `${IPC_DIR}/host.lock`
const EVENTS_FILE = `${IPC_DIR}/events.asonl`
const COMMANDS_FILE = `${IPC_DIR}/commands.asonl`

function ensureFile(file: string): void {
	if (!existsSync(file)) writeFileSync(file, '')
}

function append(file: string, item: any): void {
	appendFileSync(file, ason.stringify(item, 'short') + '\n')
}

function appendEvent(event: any): void {
	append(EVENTS_FILE, { ...event, createdAt: event.createdAt ?? new Date().toISOString() })
}

function appendCommand(command: any): void {
	append(COMMANDS_FILE, { ...command, createdAt: command.createdAt ?? new Date().toISOString() })
}

async function* tail(file: string, signal?: AbortSignal, startOffset?: number): AsyncGenerator<any> {
	ensureFile(file)
	const stream = tails.tailFile(file, { startOffset })
	for await (const value of ason.parseStream(stream)) {
		if (signal?.aborted) break
		yield value
	}
}

function tailEvents(signal?: AbortSignal) {
	return tail(EVENTS_FILE, signal)
}

function tailEventsFrom(startOffset: number, signal?: AbortSignal) {
	return tail(EVENTS_FILE, signal, startOffset)
}

function tailCommands(signal?: AbortSignal) {
	return tail(COMMANDS_FILE, signal)
}

interface HostLock {
	pid: number
	createdAt: string
}

interface EventSnapshot {
	events: any[]
	endOffset: number
}

// Delete a stale lock left by a dead process. Call this before claimHost().
// It is safe to call from both startup and client promotion polling.
function cleanupStaleLock(): void {
	const lock = readHostLock()
	if (!lock || isPidAlive(lock.pid)) return
	try { unlinkSync(HOST_LOCK) } catch {}
}

// Atomic host claim. Startup and promotion use the exact same operation:
// if the file already exists, someone else is host. If it doesn't, we win.
function claimHost(): boolean {
	ensureDir(IPC_DIR)
	ensureFile(EVENTS_FILE)
	ensureFile(COMMANDS_FILE)
	try {
		writeFileSync(HOST_LOCK, ason.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { flag: 'wx' })
		return true
	} catch (e: any) {
		if (e?.code === 'EEXIST') return false
		throw e
	}
}

function readHostLock(): HostLock | null {
	try {
		return ason.parse(readFileSync(HOST_LOCK, 'utf-8')) as unknown as HostLock
	} catch {
		return null
	}
}

function readAllEvents(): any[] {
	return readEventSnapshot().events
}

// Read the full events file and remember the byte offset we stopped at.
// Clients use this with tailEventsFrom() so they don't miss events that land
// between the snapshot read and tail startup.
function readEventSnapshot(): EventSnapshot {
	ensureFile(EVENTS_FILE)
	const content = readFileSync(EVENTS_FILE, 'utf-8')
	return {
		events: content.trim() ? ason.parseAll(content) as any[] : [],
		endOffset: Buffer.byteLength(content),
	}
}

// Self-fencing check. A server must keep verifying that host.lock still points
// at its own PID. If not, it must stop serving immediately.
function ownsHostLock(pid = process.pid): boolean {
	return readHostLock()?.pid === pid
}

// Release the host lock, but only if it still belongs to us. This prevents a
// stale process from deleting a legitimate new host's lock file.
function releaseHost(): void {
	try {
		if (!ownsHostLock()) return
		unlinkSync(HOST_LOCK)
	} catch {}
}

export const ipc = {
	appendEvent,
	appendCommand,
	tailEvents,
	tailEventsFrom,
	tailCommands,
	cleanupStaleLock,
	claimHost,
	readHostLock,
	readAllEvents,
	readEventSnapshot,
	ownsHostLock,
	releaseHost,
}
