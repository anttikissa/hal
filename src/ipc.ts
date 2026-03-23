// File-backed IPC bus. Host appends events, clients append commands.
// See commit e864a02 in previous/ for the host lock race fix history.

import {
	appendFileSync,
	readFileSync,
	existsSync,
	writeFileSync,
	unlinkSync,
} from 'fs'
import { open, readFile, writeFile, rename, rm } from 'fs/promises'
import { IPC_DIR, ensureDir } from './state.ts'
import { ason } from './utils/ason.ts'
import { tailFile } from './utils/tail-file.ts'

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
	const stream = tailFile(file)
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
//
// The lock file must ALWAYS exist once created, so that concurrent
// claimers see EEXIST on the fast path. When stealing a dead host's lock,
// we rename our claim OVER the lock (atomic overwrite) instead of
// rm + create, which is a TOCTOU race that causes dual servers.
//
// After a steal, we sleep 30ms and read back — last rename wins.
// This was verified with a 100-trial multi-process stress test.

interface HostLock {
	pid: number
	createdAt: string
}

async function claimHost(): Promise<boolean> {
	ensureDir(IPC_DIR)
	ensureFile(EVENTS_FILE)
	ensureFile(COMMANDS_FILE)

	const payload = ason.stringify({
		pid: process.pid,
		createdAt: new Date().toISOString(),
	})

	// Fast path: no lock exists — exclusive create wins atomically.
	try {
		const fh = await open(HOST_LOCK, 'wx')
		await fh.writeFile(payload)
		await fh.close()
		return true
	} catch (e: any) {
		if (e?.code !== 'EEXIST') throw e
	}

	// Lock exists — read and check if owner is alive.
	let lockPid: number | null = null
	try {
		const raw = await readFile(HOST_LOCK, 'utf-8')
		const lock = ason.parse(raw) as any
		lockPid = Number.isInteger(lock?.pid) ? lock.pid : null
	} catch {
		return false
	}

	// Owner is alive — we're a client.
	if (lockPid !== null) {
		try { process.kill(lockPid, 0); return false }
		catch {} // dead
	}

	// Dead host — steal the lock atomically.
	// Write our claim to a temp file, then rename over the lock.
	// rename() is atomic on POSIX — the lock file always exists, so
	// concurrent claimers still see EEXIST on the fast path above.
	const tmp = `${HOST_LOCK}.claim.${process.pid}`
	await writeFile(tmp, payload)
	try {
		await rename(tmp, HOST_LOCK)
	} catch {
		try { await rm(tmp) } catch {}
		return false
	}

	// Multiple stealers may rename concurrently — last rename wins.
	// Sleep briefly, then verify we still own the lock.
	await Bun.sleep(30)
	try {
		const raw = await readFile(HOST_LOCK, 'utf-8')
		const lock = ason.parse(raw) as any
		return lock?.pid === process.pid
	} catch {
		return false
	}
}

function readHostLock(): HostLock | null {
	try {
		return ason.parse(readFileSync(HOST_LOCK, 'utf-8')) as unknown as HostLock
	} catch { return null }
}

function readAllEvents(): any[] {
	ensureFile(EVENTS_FILE)
	const content = readFileSync(EVENTS_FILE, 'utf-8')
	if (!content.trim()) return []
	return ason.parseAll(content) as any[]
}

function releaseHost(): void {
	try { unlinkSync(HOST_LOCK) } catch {}
}

export const ipc = {
	appendEvent, appendCommand, tailEvents, tailCommands,
	claimHost, readHostLock, readAllEvents, releaseHost,
}
