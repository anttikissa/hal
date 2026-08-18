import { chmodSync, createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import type { WriteStream } from 'fs'
import { dirname } from 'path'
import { ason } from '../../utils/ason.ts'
import { processUtils } from '../../utils/is-pid-alive.ts'
import { clientBackend } from '../backend.ts'

type WriteOptions = {
	bypassExternalEditorLatch?: boolean
}

const config = {
	// This deliberately has no config-template.ason entry. Terminal output can
	// contain private transcript text, so capture is an explicit local opt-in.
	capture: false,
}

const MAX_CAPTURE_BYTES = 32 * 1024 * 1024

const state = {
	externalEditorOpen: false,
	capturePath: `${clientBackend.paths.stateDir}/terminal-diagnostics/terminal-output-${process.pid}.asonl`,
	captureStream: null as WriteStream | null,
	captureBytes: 0,
	captureSegment: 0,
	captureStarted: false,
	captureFailed: false,
	closing: new Map<number, Promise<void>>(),
}

function setExternalEditorOpen(value: boolean): void {
	state.externalEditorOpen = value
}

function isExternalEditorOpen(): boolean {
	return state.externalEditorOpen
}

function segmentPath(segment: number): string {
	if (segment === 0) return state.capturePath
	if (state.capturePath.endsWith('.asonl')) return `${state.capturePath.slice(0, -6)}.${segment}.asonl`
	return `${state.capturePath}.${segment}`
}

function removeSegment(segment: number): void {
	try {
		rmSync(segmentPath(segment), { force: true })
	} catch {
		// Diagnostics must never interfere with terminal output.
	}
}

function cleanupOldCaptures(dir: string): void {
	const runs = new Map<number, { mtime: number; files: string[] }>()
	for (const name of readdirSync(dir)) {
		const match = name.match(/^terminal-output-(\d+)(?:\.\d+)?\.asonl$/)
		if (!match) continue
		const pid = Number(match[1])
		const path = `${dir}/${name}`
		if (pid === process.pid) {
			rmSync(path, { force: true })
			continue
		}
		if (processUtils.isPidAlive(pid)) continue
		const run = runs.get(pid) ?? { mtime: 0, files: [] }
		try {
			run.mtime = Math.max(run.mtime, statSync(path).mtimeMs)
		} catch {
			continue
		}
		run.files.push(path)
		runs.set(pid, run)
	}
	const stale = [...runs.values()].sort((a, b) => b.mtime - a.mtime)
	for (const run of stale.slice(2)) {
		for (const path of run.files) rmSync(path, { force: true })
	}
}

function openCapture(): void {
	const stream = createWriteStream(segmentPath(state.captureSegment), { flags: 'w', mode: 0o600 })
	stream.on('error', () => {
		state.captureFailed = true
	})
	state.captureStream = stream
}

function startCapture(): void {
	if (state.captureStarted || state.captureFailed) return
	state.captureStarted = true
	try {
		const dir = dirname(state.capturePath)
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		chmodSync(dir, 0o700)
		cleanupOldCaptures(dir)
		openCapture()
	} catch {
		state.captureFailed = true
	}
}

function closeSegment(segment: number, stream: WriteStream): Promise<void> {
	const closing = new Promise<void>((resolve) => stream.end(() => resolve()))
	state.closing.set(segment, closing)
	void closing.then(() => state.closing.delete(segment))
	return closing
}

function rotateCapture(): void {
	try {
		const oldSegment = state.captureSegment
		const stream = state.captureStream
		state.captureStream = null
		if (stream) closeSegment(oldSegment, stream)
		state.captureSegment++
		state.captureBytes = 0
		openCapture()
		const expired = state.captureSegment - 2
		if (expired < 0) return
		const closing = state.closing.get(expired)
		if (closing) void closing.then(() => removeSegment(expired))
		else removeSegment(expired)
	} catch {
		state.captureFailed = true
	}
}

function capture(text: string): void {
	if (!config.capture || !text) return
	startCapture()
	if (state.captureFailed) return
	const bytes = Buffer.from(text)
	const line = `${ason.stringify({
		ts: new Date().toISOString(),
		pid: process.pid,
		rows: process.stdout.rows ?? 0,
		cols: process.stdout.columns ?? 0,
		bytes: bytes.byteLength,
		base64: bytes.toString('base64'),
	}, 'short')}\n`
	const lineBytes = Buffer.byteLength(line)
	if (state.captureBytes > 0 && state.captureBytes + lineBytes > MAX_CAPTURE_BYTES) rotateCapture()
	state.captureBytes += lineBytes
	state.captureStream?.write(line)
}

function write(text: string, opts: WriteOptions = {}): boolean {
	if (state.externalEditorOpen && !opts.bypassExternalEditorLatch) return false
	capture(text)
	return process.stdout.write(text)
}

async function flushCapture(): Promise<void> {
	await Promise.all(state.closing.values())
	const stream = state.captureStream
	if (stream) await new Promise<void>((resolve) => stream.write('', () => resolve()))
}

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => process.stdout.write('', () => resolve()))
	await flushCapture()
}

async function stopCapture(): Promise<void> {
	const stream = state.captureStream
	state.captureStream = null
	if (stream) await closeSegment(state.captureSegment, stream)
	await Promise.all(state.closing.values())
	state.captureBytes = 0
	state.captureSegment = 0
	state.captureStarted = false
	state.captureFailed = false
}

export const terminalOutput = { config, state, setExternalEditorOpen, isExternalEditorOpen, capture, write, flush, stopCapture }
