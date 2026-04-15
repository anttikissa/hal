// Read tool — read file contents with hashline prefixes.
//
// Returns file content as "LINE:HASH content" lines. The HASH is a
// 3-char fingerprint of each line's content. The edit tool verifies
// these hashes to prevent stale edits.

import { statSync } from 'fs'
import { stat, open } from 'fs/promises'
import { isAbsolute, resolve } from 'path'
import { homedir } from 'os'
import { toolRegistry, type ToolContext } from './tool.ts'
import { hashline } from './hashline.ts'

const HOME = homedir()

/** Max file size accepted by the read tool. */
const MAX_FILE_SIZE = 50_000_000

/** Max output size — 1MB per AGENTS.md rule. */
const MAX_OUTPUT_BYTES = 1_000_000

/** Check only the first few KB for null bytes to reject binary files. */
const BINARY_SAMPLE_BYTES = 8192

/** Read in bounded chunks so large files do not block the event loop. */
const READ_CHUNK_BYTES = 64 * 1024

const TRUNCATED_SUFFIX = '\n[… truncated]'

/** Resolve a path relative to cwd, handling ~ expansion. */
function resolvePath(path: string | undefined, cwd: string): string {
	if (!path?.trim()) return cwd
	if (path.startsWith('~/')) path = HOME + path.slice(1)
	return isAbsolute(path) ? path : resolve(cwd, path)
}

/** Format already-selected lines without loading the whole file again. */
function formatSelectedLines(lines: string[], startLine: number): string {
	if (lines.length === 0) return ''
	const endLine = startLine + lines.length - 1
	const width = String(endLine).length
	return lines.map((line, i) => {
		const lineNo = startLine + i
		return `${String(lineNo).padStart(width)}:${hashline.hashLine(line)} ${line}`
	}).join('\n')
}

/**
 * Trim text to a UTF-8 byte budget. We keep the truncation marker inside the
 * limit so the tool result itself still respects the 1MB cap.
 */
function truncateUtf8(text: string, limit: number): string {
	if (Buffer.byteLength(text, 'utf8') <= limit) return text

	const suffixBytes = Buffer.byteLength(TRUNCATED_SUFFIX, 'utf8')
	const budget = limit - suffixBytes
	if (budget <= 0) return TRUNCATED_SUFFIX.slice(0, limit)

	let lo = 0
	let hi = text.length
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2)
		if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= budget) {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return text.slice(0, lo) + TRUNCATED_SUFFIX
}

/**
 * Read just the requested line range. For bounded ranges we stop early once we
 * have the lines we need and have also sampled enough bytes for the binary check.
 */
async function readSelectedLines(path: string, start: number, end: number | undefined, signal?: AbortSignal): Promise<{ lines: string[]; sawBinary: boolean }> {
	const file = await open(path, 'r')
	const selected: string[] = []
	const buffer = Buffer.alloc(READ_CHUNK_BYTES)
	const decoder = new TextDecoder()
	const firstLine = Math.max(1, start)
	let pending = ''
	let lineNo = 1
	let sampledBytes = 0
	let sawBinary = false

	try {
		while (true) {
			if (signal?.aborted) throw new Error('aborted')

			const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
			if (bytesRead === 0) break

			const sampleSize = Math.min(bytesRead, BINARY_SAMPLE_BYTES - sampledBytes)
			if (sampleSize > 0) {
				// Null bytes are a cheap and good-enough signal that this is binary data.
				if (buffer.subarray(0, sampleSize).includes(0)) sawBinary = true
				sampledBytes += sampleSize
			}

			pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true })

			let newline = pending.indexOf('\n')
			while (newline !== -1) {
				const line = pending.slice(0, newline)
				pending = pending.slice(newline + 1)

				if (lineNo >= firstLine && (end === undefined || lineNo <= end)) selected.push(line)
				lineNo += 1

				if (end !== undefined && lineNo > end && sampledBytes >= BINARY_SAMPLE_BYTES) {
					return { lines: selected, sawBinary }
				}

				newline = pending.indexOf('\n')
			}
		}

		pending += decoder.decode()
		if (pending !== '' && lineNo >= firstLine && (end === undefined || lineNo <= end)) {
			selected.push(pending)
		}
		return { lines: selected, sawBinary }
	} finally {
		await file.close()
	}
}

async function execute(input: any, ctx: ToolContext): Promise<string> {
	const path = resolvePath(input?.path, ctx.cwd)
	const start = Number.isFinite(Number(input?.start)) ? Number(input.start) : 1
	const end = input?.end === undefined ? undefined : Number(input.end)

	try {
		const info = await stat(path)
		if (info.isDirectory()) return `error: ${path} is a directory, not a file`
		if (info.size > MAX_FILE_SIZE) return `error: file too large (${info.size} bytes)`
	} catch (e: any) {
		return `error: ${e.message}`
	}

	let selection: { lines: string[]; sawBinary: boolean }
	try {
		selection = await readSelectedLines(path, start, end, ctx.signal)
	} catch (e: any) {
		return `error: ${e.message}`
	}

	if (selection.sawBinary) return `error: ${path} appears to be a binary file`

	const result = formatSelectedLines(selection.lines, Math.max(1, start))
	return truncateUtf8(result, MAX_OUTPUT_BYTES)
}

const readTool = {
	name: 'read',
	description: 'Read a file with line numbers. Use optional start/end for a line range.',
	parameters: {
		path: { type: 'string', description: 'File path (absolute or relative to cwd)' },
		start: { type: 'integer', description: 'First line number (1-based, inclusive)' },
		end: { type: 'integer', description: 'Last line number (inclusive)' },
	},
	required: ['path'],
	execute,
}

function init(): void {
	toolRegistry.registerTool(readTool)
}

/**
 * Resolve a path string that may contain space-separated multiple paths.
 * If the full string resolves to an existing path, return it as-is (single element).
 * Otherwise, split on spaces and check if each part exists. If all do, return
 * them all — the model intended multiple paths. If not, return the original
 * single path (let the caller surface the "not found" error).
 */
function resolvePaths(raw: string | undefined, cwd: string): string[] {
	const single = resolvePath(raw, cwd)
	try {
		statSync(single)
		return [single]
	} catch {
		// Single path doesn't exist — try splitting on spaces
	}
	const parts = (raw ?? '').split(/\s+/).filter(Boolean)
	if (parts.length <= 1) return [single]

	const resolved = parts.map(p => resolvePath(p, cwd))
	const allExist = resolved.every(p => {
		try {
			statSync(p)
			return true
		} catch {
			return false
		}
	})
	return allExist ? resolved : [single]
}

export const read = { resolvePath, resolvePaths, execute, init }
