import { appendFileSync, writeFileSync, readFileSync, existsSync, unlinkSync, watch } from "fs"
import { open } from "fs/promises"
import { IPC_DIR, ensureDir } from "./state.ts"

const HOST_LOCK = `${IPC_DIR}/host.lock`
const EVENTS_FILE = `${IPC_DIR}/events.jsonl`
const COMMANDS_FILE = `${IPC_DIR}/commands.jsonl`

// --- Append-only log ---

function appendLog(file: string, item: any): void {
	appendFileSync(file, JSON.stringify(item) + "\n")
}

function ensureFile(file: string): void {
	if (!existsSync(file)) writeFileSync(file, "")
}

export function appendEvent(event: any): void {
	appendLog(EVENTS_FILE, event)
}

export function appendCommand(command: any): void {
	appendLog(COMMANDS_FILE, command)
}

// Tail a log file, yielding new lines as they appear
export async function* tailLog(file: string, signal?: AbortSignal): AsyncGenerator<any> {
	ensureFile(file)
	let offset = 0
	const content = readFileSync(file, "utf-8")
	offset = content.length

	while (!signal?.aborted) {
		const current = readFileSync(file, "utf-8")
		if (current.length > offset) {
			const newData = current.slice(offset)
			offset = current.length
			for (const line of newData.split("\n")) {
				if (line.trim()) {
					try {
						yield JSON.parse(line)
					} catch {}
				}
			}
		}
		// Wait for changes
		await new Promise<void>((resolve) => {
			const watcher = watch(file, () => {
				watcher.close()
				resolve()
			})
			// Fallback poll
			const timer = setTimeout(() => {
				watcher.close()
				resolve()
			}, 100)
			signal?.addEventListener("abort", () => {
				clearTimeout(timer)
				watcher.close()
				resolve()
			})
		})
	}
}

export function tailEvents(signal?: AbortSignal) {
	return tailLog(EVENTS_FILE, signal)
}

export function tailCommands(signal?: AbortSignal) {
	return tailLog(COMMANDS_FILE, signal)
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
		const fh = await open(HOST_LOCK, "wx")
		const lock: HostLock = { pid: process.pid, createdAt: new Date().toISOString() }
		await fh.writeFile(JSON.stringify(lock))
		await fh.close()
		return true
	} catch (e: any) {
		if (e?.code === "EEXIST") {
			// Check if existing host is alive
			try {
				const lock: HostLock = JSON.parse(readFileSync(HOST_LOCK, "utf-8"))
				process.kill(lock.pid, 0)
				return false // host is alive
			} catch {
				// Dead host, remove stale lock and retry
				try { unlinkSync(HOST_LOCK) } catch {}
				return claimHost()
			}
		}
		throw e
	}
}

export function readHostLock(): HostLock | null {
	try {
		return JSON.parse(readFileSync(HOST_LOCK, "utf-8"))
	} catch {
		return null
	}
}

export function releaseHost(): void {
	try { unlinkSync(HOST_LOCK) } catch {}
}
