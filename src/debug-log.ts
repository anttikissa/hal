/**
 * Streaming debug log for reproducing UI bugs.
 *
 * Gated on config.debug.recordEverything.
 * Writes append-only to state/debug/process.<pid>.ason.
 * Starts with snapshots of all state files + config, then streams keypresses.
 * /snapshot (or the snapshot tool) appends a terminal content capture.
 * /bug <desc> appends a bug record with terminal snapshot and saves a copy.
 */

import { appendFile, mkdir, readFile, readdir, stat, copyFile } from "fs/promises"
import { resolve, relative } from "path"
import { stringify } from "./utils/ason.ts"
import { STATE_DIR, HAL_DIR } from "./state.ts"
import { loadConfig } from "./config.ts"

const DEBUG_DIR = `${STATE_DIR}/debug`
const BUGS_DIR = `${STATE_DIR}/bugs`
let logPath: string | null = null
let enabled = false
let buffer: any[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_MS = 100

export function getDebugLogPath(): string | null { return logPath }

async function flush(): Promise<void> {
	if (!logPath || buffer.length === 0) return
	const records = buffer
	buffer = []
	flushTimer = null
	const lines = records.map(r => stringify(r)).join("\n") + "\n"
	await appendFile(logPath, lines)
}

function scheduleFlush(): void {
	if (flushTimer) return
	flushTimer = setTimeout(() => flush().catch(() => {}), FLUSH_MS)
}

function push(record: any): void {
	if (!enabled) return
	buffer.push(record)
	scheduleFlush()
}

export function logKeypress(key: string): void {
	push({ t: Date.now(), type: "keypress", key })
}

export function logSnapshot(terminal: string): void {
	// Snapshots always work (even when not recording) so /snapshot is useful on its own
	if (!logPath) return
	buffer.push({ t: Date.now(), type: "snapshot", terminal })
	scheduleFlush()
}

/** Log a bug report and save a copy of the debug log to state/bugs/ */
export async function saveBugReport(description: string, terminal: string): Promise<string | null> {
	if (!logPath) return null
	// Append the bug record + snapshot
	buffer.push({ t: Date.now(), type: "bug", description, terminal })
	await flush()
	// Copy the debug log to bugs dir
	await mkdir(BUGS_DIR, { recursive: true })
	const id = `bug-${Date.now()}`
	const bugPath = resolve(BUGS_DIR, `${id}.ason`)
	await copyFile(logPath, bugPath)
	return bugPath
}

/** Walk a directory, calling fn for each file. Skips the debug dir. */
async function walkFiles(dir: string, fn: (path: string) => Promise<void>): Promise<void> {
	const debugPrefix = resolve(DEBUG_DIR)
	const bugsPrefix = resolve(BUGS_DIR)
	let entries: string[]
	try { entries = await readdir(dir) } catch { return }
	for (const entry of entries) {
		const full = resolve(dir, entry)
		if (full.startsWith(debugPrefix) || full.startsWith(bugsPrefix)) continue
		try {
			const s = await stat(full)
			if (s.isDirectory()) await walkFiles(full, fn)
			else await fn(full)
		} catch {}
	}
}

export async function initDebugLog(pid: number): Promise<void> {
	await mkdir(DEBUG_DIR, { recursive: true })
	logPath = resolve(DEBUG_DIR, `process.${pid}.ason`)
	enabled = loadConfig().debug?.recordEverything === true

	if (!enabled) return

	// Snapshot config.ason (non-secret settings)
	try {
		const content = await readFile(resolve(HAL_DIR, "config.ason"), "utf-8")
		push({ t: Date.now(), type: "config", content })
	} catch {}

	// Snapshot all state files
	await walkFiles(STATE_DIR, async (full) => {
		try {
			const content = await readFile(full, "utf-8")
			const name = `state/${relative(STATE_DIR, full)}`
			push({ t: Date.now(), type: "file", name, content })
		} catch {}
	})

	// Force initial flush
	await flush()
}
