// File-backed IPC bus. Host appends events, clients append commands.

import {
	appendFileSync,
	readFileSync,
	existsSync,
	writeFileSync,
	unlinkSync,
} from 'fs'
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

export function appendEvent(event: any): void {
	append(EVENTS_FILE, event)
}

export function appendCommand(command: any): void {
	append(COMMANDS_FILE, command)
}

async function* tail(file: string, signal?: AbortSignal): AsyncGenerator<any> {
	ensureFile(file)
	const stream = tailFile(file)
	for await (const value of ason.parseStream(stream)) {
		if (signal?.aborted) break
		yield value
	}
}

export function tailEvents(signal?: AbortSignal) {
	return tail(EVENTS_FILE, signal)
}

export function tailCommands(signal?: AbortSignal) {
	return tail(COMMANDS_FILE, signal)
}

// --- Host election ---

export interface HostLock {
	pid: number
	createdAt: string
}

export async function claimHost(): Promise<boolean> {
	ensureDir(IPC_DIR)
	ensureFile(EVENTS_FILE)
	ensureFile(COMMANDS_FILE)
	try {
		const fh = await open(HOST_LOCK, 'wx')
		const lock: HostLock = {
			pid: process.pid,
			createdAt: new Date().toISOString(),
		}
		await fh.writeFile(ason.stringify(lock))
		await fh.close()
		return true
	} catch (e: any) {
		if (e?.code === 'EEXIST') {
			try {
				const lock = ason.parse(
					readFileSync(HOST_LOCK, 'utf-8')
				) as unknown as HostLock
				process.kill(lock.pid, 0)
				return false
			} catch {
				try {
					unlinkSync(HOST_LOCK)
				} catch {}
				return claimHost()
			}
		}
		throw e
	}
}

export function readHostLock(): HostLock | null {
	try {
		return ason.parse(
			readFileSync(HOST_LOCK, 'utf-8')
		) as unknown as HostLock
	} catch {
		return null
	}
}

export function readAllEvents(): any[] {
	ensureFile(EVENTS_FILE)
	const content = readFileSync(EVENTS_FILE, "utf-8")
	if (!content.trim()) return []
	return ason.parseAll(content) as any[]
}

export function releaseHost(): void {
	try {
		unlinkSync(HOST_LOCK)
	} catch {}
}
