// Editing leases (task 3fv): READ shows a text file as numbered lines
// under `path@hash`, the hash covering the whole file; EDIT names that
// lease and changes line ranges of exactly that version, all at once.
// The hash is a stale-file check, not a security boundary: five
// Crockford base32 characters, the first 25 bits of SHA-256.

import { createHash, randomUUID } from 'crypto'
import { chmod, open, readFile, realpath, rename, stat, unlink } from 'fs/promises'
import { basename, dirname } from 'path'
import { tools } from './tools.ts'

const alphabet = '0123456789abcdefghjkmnpqrstvwxyz'

function hash(bytes: Uint8Array): string {
	let n = createHash('sha256').update(bytes).digest().readUInt32BE(0) >>> 7
	let out = ''
	for (let i = 0; i < 5; i++) {
		out = alphabet[n & 31] + out
		n >>>= 5
	}
	return out
}

// A file's text split into lines, each keeping its own terminator so
// unchanged lines keep CRLF or LF as they were. The BOM stays apart.
export type Text = { bom: string; lines: string[] }
function text(bytes: Uint8Array, path: string): Text {
	let decoded: string
	try {
		decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
	} catch {
		throw new Error(`${path} is not valid UTF-8 text; use BASH to inspect or change it`)
	}
	let bom = decoded.startsWith('\uFEFF') ? '\uFEFF' : ''
	return { bom, lines: decoded.slice(bom.length).match(/[^\n]*\n|[^\n]+$/g) ?? [] }
}

const strip = (line: string) => line.replace(/\r?\n$/, '')

// Numbered lines, each cut at tools.maxLineChars, `…` between gaps.
function numbered(lines: string[], shown: number[]): string {
	let out: string[] = []
	let max = tools.maxLineChars
	for (let [i, n] of shown.entries()) {
		if (i && n !== shown[i - 1]! + 1) out.push('…')
		let line = strip(lines[n - 1]!)
		if (line.length > max) line = `${line.slice(0, max)}… [line cut: ${line.length - max} more characters]`
		out.push(`${n}: ${line}`)
	}
	return out.join('\n')
}

// READ of lines offset..offset+limit-1 (1-based; no limit: to the end),
// clamped to the file, within tools.maxLines and tools.maxChars. `hint`:
// the range was a default, so say how to read more when lines remain.
function read(path: string, bytes: Uint8Array, offset = 1, limit?: number, hint = false): string {
	let { lines } = lease.text(bytes, path)
	let header = `== READ ${path}@${lease.hash(bytes)} ==`
	if (!lines.length) return `${header}\n[Empty file]`
	let start = Math.max(1, offset)
	let end = Math.min(lines.length, limit === undefined ? lines.length : offset + limit - 1)
	if (start > end) return `${header}\n[Empty range: the file has ${lines.length} lines]`
	let out: string[] = []
	let size = header.length
	let n = start
	for (; n <= end; n++) {
		let line = lease.numbered(lines, [n])
		if ((size + line.length > tools.maxChars - 200 || n - start >= tools.maxLines) && n > start) break
		out.push(line)
		size += line.length + 1
	}
	let more = n <= end ? `\n[lines ${start}-${n - 1} of ${lines.length}; continue with READ "${path}:${n}-${end === lines.length ? '' : end}"]`
		: hint && end < lines.length ? `\n[lines ${start}-${end} of ${lines.length}; READ "${path}:${end + 1}-${Math.min(lines.length, end + limit!)}" for more, "${path}:1-" for the whole file]`
		: ''
	return `${header}\n${out.join('\n')}${more}`
}

// "1-2", "1,2", 7 or [1, 2]: an inclusive 1-based range.
export type Range = { start: number; end: number }
function range(value: unknown): Range {
	let parts = typeof value === 'number' ? [value, value]
		: Array.isArray(value) ? value
		: typeof value === 'string' && /^\s*\d+\s*(?:[-,]\s*\d+\s*)?$/.test(value) ? value.split(/[-,]/).map(Number)
		: undefined
	if (parts?.length === 1) parts = [parts[0], parts[0]]
	let [start, end] = parts ?? []
	if (parts?.length !== 2 || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
		throw new Error(`range must be "start-end" (1-based, inclusive, start <= end) or one line number, got ${JSON.stringify(value)}`)
	}
	return { start, end }
}

export type Change = Range & { lines: string[] }

// The new text for `changes`, which all refer to `before`, and the
// lines to show around each changed place in the result. Past-EOF starts
// append; ends past EOF stop there. Overlaps are refused before anything
// is written.
function apply(before: Text, changes: Change[]): { after: string; shown: number[]; lines: string[] } {
	let old = before.lines
	let n = old.length
	let clamped = changes.map((c) => ({ ...c, start: Math.min(c.start, n + 1), end: Math.min(c.end, n) })).sort((a, b) => a.start - b.start)
	for (let i = 1; i < clamped.length; i++) {
		let [a, b] = [clamped[i - 1]!, clamped[i]!]
		if (b.start <= Math.max(a.start, a.end)) throw new Error(`ranges ${a.start}-${a.end} and ${b.start}-${b.end} overlap (after clamping to the file's ${n} lines); nothing was written`)
	}
	let crlf = old.filter((l) => l.endsWith('\r\n')).length
	let eol = crlf * 2 > old.filter((l) => l.endsWith('\n')).length ? '\r\n' : '\n'
	let finalNewline = !n || old[n - 1]!.endsWith('\n')
	let lines = [...old]
	for (let c of [...clamped].reverse()) lines.splice(c.start - 1, Math.max(0, c.end - c.start + 1), ...c.lines.flatMap((l) => l.split(/\r?\n/)).map((l) => l + eol))
	for (let i = 0; i < lines.length - 1; i++) if (!lines[i]!.endsWith('\n')) lines[i] += eol
	if (lines.length && !finalNewline) lines[lines.length - 1] = strip(lines.at(-1)!)
	// Where each change landed: two lines before its start and after its end.
	let shown = new Set<number>()
	let shift = 0
	for (let c of clamped) {
		let count = c.lines.flatMap((l) => l.split(/\r?\n/)).length
		let s = c.start + shift
		let windows = count ? [[s - 2, s], [s + count - 1, s + count + 1]] : [[s - 2, s + 1]]
		for (let [a, b] of windows) for (let k = Math.max(1, a!); k <= Math.min(lines.length, b!); k++) shown.add(k)
		shift += count - Math.max(0, c.end - c.start + 1)
	}
	return { after: before.bom + lines.join(''), shown: [...shown].sort((a, b) => a - b), lines }
}

// Lines around each requested endpoint (±2) of the current file, for a
// failed EDIT to show what is there now.
function around(current: Text, changes: Change[]): string {
	let n = current.lines.length
	let shown = new Set<number>()
	for (let c of changes) for (let at of [c.start, c.end]) {
		let p = Math.max(1, Math.min(n, at))
		for (let k = Math.max(1, p - 2); k <= Math.min(n, p + 2); k++) shown.add(k)
	}
	return n ? lease.numbered(current.lines, [...shown].sort((a, b) => a - b)) : '[Empty file]'
}

// Replaces `path` (through symlinks, keeping its mode) with `bytes`
// atomically: a temp file beside it, renamed over it. `expected`: the
// bytes it must still hold just before the rename; another process
// that changed it since makes this throw, writing nothing.
async function commit(path: string, bytes: Uint8Array, expected?: Uint8Array): Promise<void> {
	let target = await realpath(path).catch((e) => { if (e.code === 'ENOENT' && !expected) return path; throw e })
	let mode = await stat(target).then((s) => s.mode & 0o7777, (e) => { if (e.code === 'ENOENT') return 0o666 & ~process.umask(); throw e })
	let temp = `${dirname(target)}/.${basename(target)}.hal-${randomUUID().slice(0, 8)}`
	let file = await open(temp, 'wx', mode)
	try {
		try { await file.writeFile(bytes) } finally { await file.close() }
		await chmod(temp, mode)
		if (expected) {
			let now = await readFile(target)
			if (!now.equals(expected)) throw new Error(`${path} changed outside Hal while the edit ran (now ${lease.hash(now)}); nothing was written. READ it again.`)
		}
		await rename(temp, target)
	} finally {
		await unlink(temp).catch((e) => { if (e.code !== 'ENOENT') throw e })
	}
}

export const lease = { hash, text, numbered, read, range, apply, around, commit }
