// File-backed IPC bus. Host appends events, clients append commands.

import { appendFileSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs'
import { open } from 'fs/promises'
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

interface HostLock {
	pid: number
	createdAt: string
}

// Initial claim only. Used at startup when no host exists.
// open('wx') is atomic — if file exists, fails with EEXIST.
async function claimHost(): Promise<boolean> {
	ensureDir(IPC_DIR)
	ensureFile(EVENTS_FILE)
	ensureFile(COMMANDS_FILE)
	try {
		const fh = await open(HOST_LOCK, 'wx')
		await fh.writeFile(ason.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
		await fh.close()
		return true
	} catch (e: any) {
		if (e?.code === 'EEXIST') return false
		throw e
	}
}

// Promotion via IPC consensus. Clients append a promote event, wait for
// others, then read the log. First promote event after host-released wins.
async function promote(): Promise<boolean> {
	appendEvent({ type: 'promote', pid: process.pid })
	await Bun.sleep(50)
	const events = readAllEvents()
	// Find first promote event after the last host-released.
	let i = events.length - 1
	while (i >= 0 && events[i]?.type !== 'host-released') i--
	const first = events.slice(i + 1).find((e: any) => e.type === 'promote')
	if (!first || first.pid !== process.pid) return false
	try {
		unlinkSync(HOST_LOCK)
	} catch {}
	writeFileSync(HOST_LOCK, ason.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
	return true
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

function releaseHost(): void {
	try {
		unlinkSync(HOST_LOCK)
	} catch {}
}

export const ipc = {
	appendEvent,
	appendCommand,
	tailEvents,
	tailCommands,
	claimHost,
	promote,
	readHostLock,
	readAllEvents,
	releaseHost,
}
