/**
 * Streaming debug log for reproducing UI bugs.
 *
 * Gated on config.debug.recordEverything.
 * Writes append-only to state/debug/process.<pid>.ason.
 * Starts with snapshots of all state files + config, then streams keypresses.
 * /snapshot (or the snapshot tool) appends a terminal content capture.
 * /bug <desc> appends a bug record with terminal snapshot and saves a copy.
 */

import { appendFile, mkdir, readFile, readdir, rm, stat } from 'fs/promises'

import { resolve, relative } from 'path'
import { stringify } from './utils/ason.ts'
import { STATE_DIR, HAL_DIR } from './state.ts'
import { loadConfig, debugMaxDiskBytes } from './config.ts'

const DEBUG_DIR = `${STATE_DIR}/debug`
const BUGS_DIR = `${STATE_DIR}/bugs`
let logPath: string | null = null
let enabled = false
let buffer: any[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_MS = 100
let pruning = false
let pendingPrune = false

export function getDebugLogPath(): string | null {
	return logPath
}

async function flush(): Promise<void> {
	if (!logPath || buffer.length === 0) return
	const records = buffer
	buffer = []
	flushTimer = null
	const lines = records.map((r) => stringify(r, 'short')).join('\n') + '\n'
	await appendFile(logPath, lines)
	schedulePrune()
}

async function runPrune(): Promise<void> {
	if (pruning) {
		pendingPrune = true
		return
	}
	pruning = true
	try {
		const limit = debugMaxDiskBytes()
		if (limit <= 0) return
		type Entry = { path: string; size: number; mtimeMs: number }
		const entries: Entry[] = []
		for (const dir of [DEBUG_DIR, BUGS_DIR]) {
			let names: string[]
			try {
				names = await readdir(dir)
			} catch {
				continue
			}
			for (const name of names) {
				const full = resolve(dir, name)
				let s: Awaited<ReturnType<typeof stat>>
				try {
					s = await stat(full)
				} catch {
					continue
				}
				if (!s.isFile()) continue
				entries.push({ path: full, size: s.size, mtimeMs: s.mtimeMs })
			}
		}
		let total = entries.reduce((sum, e) => sum + e.size, 0)
		if (total <= limit) return
		entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
		for (const entry of entries) {
			if (total <= limit) break
			if (entry.path === logPath) continue
			try {
				await rm(entry.path, { force: true })
				total -= entry.size
			} catch {}
		}
	} finally {
		pruning = false
		if (pendingPrune) {
			pendingPrune = false
			void runPrune()
		}
	}
}

function schedulePrune(): void {
	void runPrune()
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
	push({ t: Date.now(), type: 'keypress', key })
}

export function logSnapshot(terminal: string): void {
	// Snapshots always work (even when not recording) so /snapshot is useful on its own
	if (!logPath) return
	buffer.push({ t: Date.now(), type: 'snapshot', terminal })
	scheduleFlush()
}

/** Log a bug report and save a copy of the debug log to state/bugs/ */
export async function saveBugReport(description: string, terminal: string): Promise<string | null> {
	if (!logPath) return null
	// Append the bug record + snapshot
	buffer.push({ t: Date.now(), type: 'bug', description, terminal })
	await flush()
	// Copy the debug log to bugs dir without blocking the event loop
	await mkdir(BUGS_DIR, { recursive: true })
	const id = `bug-${Date.now()}`
	const bugPath = resolve(BUGS_DIR, `${id}.ason`)
	await Bun.write(bugPath, Bun.file(logPath))
	schedulePrune()
	return bugPath
}

/** Walk a directory, calling fn for each file. Skips the debug dir. */
async function walkFiles(dir: string, fn: (path: string) => Promise<void>): Promise<void> {
	const debugPrefix = resolve(DEBUG_DIR)
	const bugsPrefix = resolve(BUGS_DIR)
	let entries: string[]
	try {
		entries = await readdir(dir)
	} catch {
		return
	}
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
	schedulePrune()

	if (!enabled) return

	// Snapshot config + state files in the background (don't block startup)
	snapshotState().catch(() => {})
}

async function snapshotState(): Promise<void> {
	try {
		const content = await readFile(resolve(HAL_DIR, 'config.ason'), 'utf-8')
		push({ t: Date.now(), type: 'config', content })
	} catch {}

	await walkFiles(STATE_DIR, async (full) => {
		try {
			const content = await readFile(full, 'utf-8')
			const name = `state/${relative(STATE_DIR, full)}`
			push({ t: Date.now(), type: 'file', name, content })
		} catch {}
	})

	await flush()
}
