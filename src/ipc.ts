// File-backed IPC bus. Host appends events, clients append commands.

import { appendFileSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs'
import { IPC_DIR, ensureDir } from './state.ts'
import { ason } from './utils/ason.ts'
import { liveFiles } from './utils/live-file.ts'
import { tails } from './utils/tail-file.ts'
import { isPidAlive } from './utils/is-pid-alive.ts'
import type { VersionStatus } from './version.ts'

const HOST_LOCK = `${IPC_DIR}/host.lock`
const EVENTS_FILE = `${IPC_DIR}/events.asonl`
const COMMANDS_FILE = `${IPC_DIR}/commands.asonl`
const STATE_FILE = `${IPC_DIR}/state.ason`

export interface SharedSessionInfo {
	id: string
	name?: string
	cwd: string
	model?: string
}

export interface SharedHostInfo {
	pid: number | null
	startedAt: string
	versionStatus: VersionStatus
	version?: string
	error?: string
}

export interface SharedState {
	sessions: string[]
	openSessions: SharedSessionInfo[]
	busy: Record<string, boolean>
	activity: Record<string, string>
	host?: SharedHostInfo
	updatedAt: string
}

function defaultState(): SharedState {
	return {
		sessions: [],
		openSessions: [],
		busy: {},
		activity: {},
		host: { pid: null, startedAt: '', versionStatus: 'idle' },
		updatedAt: new Date().toISOString(),
	}
}

function ensureFile(file: string): void {
	if (!existsSync(file)) writeFileSync(file, '')
}

function append(file: string, item: any): void {
	ensureDir(IPC_DIR)
	ensureFile(file)
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

interface HostLock {
	pid: number
	createdAt: string
}

let stateFile: SharedState | null = null

function getStateFile(): SharedState {
	if (stateFile) return stateFile
	ensureDir(IPC_DIR)
	stateFile = liveFiles.liveFile(STATE_FILE, defaultState(), { watch: false }) as SharedState
	if (!Array.isArray(stateFile.sessions)) stateFile.sessions = []
	if (!Array.isArray(stateFile.openSessions)) stateFile.openSessions = []
	if (!stateFile.busy || typeof stateFile.busy !== 'object') stateFile.busy = {}
	if (!stateFile.activity || typeof stateFile.activity !== 'object') stateFile.activity = {}
	if (typeof stateFile.updatedAt !== 'string') stateFile.updatedAt = new Date().toISOString()
	return stateFile
}

function readState(): SharedState {
	return getStateFile()
}

// Shared runtime state belongs in state.ason, not in the unbounded events log.
// This file is the bootstrap source of truth for new clients.
function updateState(mutator: (state: SharedState) => void): SharedState {
	const state = getStateFile()
	mutator(state)
	state.updatedAt = new Date().toISOString()
	// Callers often append a matching event right after updating state. Force the
	// flush here so new clients never observe the event before the bootstrap file.
	liveFiles.save(state)
	return state
}

// Delete a stale lock left by a dead process. Call this before claimHost().
// It is safe to call from both startup and client promotion polling.
function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

function isMissingFileError(err: unknown): boolean {
	return !!err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT'
}

function cleanupStaleLock(): void {
	const lock = readHostLock()
	if (!lock || isPidAlive(lock.pid)) return
	try {
		unlinkSync(HOST_LOCK)
	} catch (err) {
		if (!isMissingFileError(err)) console.error(`[ipc] failed to remove stale host lock: ${errorMessage(err)}`)
	}
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
	} catch (err) {
		if (!isMissingFileError(err)) console.error(`[ipc] failed to read host lock: ${errorMessage(err)}`)
		return null
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
	} catch (err) {
		if (!isMissingFileError(err)) console.error(`[ipc] failed to release host lock: ${errorMessage(err)}`)
	}
}

export const ipc = {
	appendEvent,
	appendCommand,
	tailEvents,
	tailCommands,
	readState,
	updateState,
	cleanupStaleLock,
	claimHost,
	readHostLock,
	ownsHostLock,
	releaseHost,
}
