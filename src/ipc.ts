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

async function* tail(file: string, signal?: AbortSignal): AsyncGenerator<any> {
	ensureFile(file)
	const stream = tails.tailFile(file)
	for await (const value of ason.parseStream(stream)) {
		if (signal?.aborted) break
		yield value
	}
}

function tailEvents(signal?: AbortSignal) {
	return tail(EVENTS_FILE, signal)
}

function tailCommands(signal?: AbortSignal) {
	return tail(COMMANDS_FILE, signal)
}

// --- Host election ---

interface HostLock {
	pid: number
	createdAt: string
}

// Remove a stale lock left by a crashed/killed process at startup.
// Must be called before claimHost(). Checks if the current lock holder
// is still alive; if not, deletes the lock so claimHost can proceed.
function cleanupStaleLock(): void {
	const lock = readHostLock()
	if (!lock) return // no lock or unreadable
	if (!isPidAlive(lock.pid)) {
		try { unlinkSync(HOST_LOCK) } catch {}
	}
}

// Atomically claim host at startup.
// writeFileSync with 'wx' flag creates the file exclusively (O_CREAT | O_EXCL)
// and writes PID data in a single syscall — no empty-file window.
//
// IMPORTANT: Stale lock cleanup must happen before this call
// (via cleanupStaleLock), not inside it. If we tried to detect
// and remove stale locks here, we'd race with the winner's async write:
// process A creates the file but hasn't written PID yet → process B
// reads an empty file, thinks it's stale, deletes it → dual host.
function claimHost(): boolean {
	ensureDir(IPC_DIR)
	ensureFile(EVENTS_FILE)
	ensureFile(COMMANDS_FILE)
	try {
		const data = ason.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
		writeFileSync(HOST_LOCK, data, { flag: 'wx' })
		return true
	} catch (e: any) {
		if (e?.code === 'EEXIST') return false
		throw e
	}
}

// Promotion: atomically create the lock file using open('wx').
// This is the same mechanism as claimHost — only one process can
// create the file, so exactly one wins. If EEXIST, another process
// already won this election round; return false immediately.
//
// For crash recovery (stale lock from dead server), the caller must
// call clearStaleLock() first, then promote(). The unlink + open('wx')
// pair is safe because open('wx') is atomic — even if multiple processes
// race to unlink, only one subsequent open('wx') can succeed.
function promote(): boolean {
	try {
		const data = ason.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
		writeFileSync(HOST_LOCK, data, { flag: 'wx' })
		appendEvent({ type: 'promote', pid: process.pid })
		return true
	} catch (e: any) {
		if (e?.code === 'EEXIST') return false
		throw e
	}
}

// Remove a stale lock left by a crashed server (no host-released event).
// Called from poll-based crash detection before attempting promote().
function clearStaleLock(): void {
	try { unlinkSync(HOST_LOCK) } catch {}
}

function readHostLock(): HostLock | null {
	try {
		return ason.parse(readFileSync(HOST_LOCK, 'utf-8')) as unknown as HostLock
	} catch {
		return null
	}
}

function readAllEvents(): any[] {
	ensureFile(EVENTS_FILE)
	const content = readFileSync(EVENTS_FILE, 'utf-8')
	if (!content.trim()) return []
	return ason.parseAll(content) as any[]
}

// Release the host lock, but ONLY if it belongs to us.
// Without this check, a rogue process that incorrectly thinks it's host
// (e.g. from a prior bug) could delete a legitimate new process's lock.
function releaseHost(): void {
	try {
		const lock = readHostLock()
		if (lock && lock.pid !== process.pid) return // not our lock — don't touch it
		unlinkSync(HOST_LOCK)
	} catch {}
}

export const ipc = {
	appendEvent,
	appendCommand,
	tailEvents,
	tailCommands,
	cleanupStaleLock,
	claimHost,
	promote,
	clearStaleLock,
	readHostLock,
	readAllEvents,
	releaseHost,
}
