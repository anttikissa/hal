// Hashline — line-level addressing for file edits.
//
// Each line gets a short hash derived from its normalized content.
// The read tool outputs "LINE:HASH content" and the edit tool uses
// LINE:HASH refs to identify lines. If the file changes between
// read and edit, the hash won't match and the edit is rejected.
//
// Hash collisions are possible but rare — 3 chars from a 62-char
// alphabet gives ~238k values. Good enough for per-file line IDs.

import { createHash } from 'crypto'

const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const BASE = ALPHA.length

export interface HashlineRef {
	line: number
	hash: string
}

// Hash a single line: normalize whitespace, MD5, take 3 base-62 chars.
function hashLine(line: string): string {
	const norm = line.trim().replace(/\s+/g, ' ')
	const md5 = createHash('md5').update(norm).digest()
	const n = (md5[0]! << 16) | (md5[1]! << 8) | md5[2]!
	return ALPHA[n % BASE]! + ALPHA[Math.floor(n / BASE) % BASE]! + ALPHA[Math.floor(n / (BASE * BASE)) % BASE]!
}

// Format file content as "LINE:HASH content" lines.
function formatHashlines(content: string, start = 1, end?: number): string {
	const lines = toLines(content)
	const s = Math.max(1, start)
	const e = Math.min(lines.length, end ?? lines.length)
	const width = String(e).length
	return lines.slice(s - 1, e)
		.map((line, i) => `${String(s + i).padStart(width)}:${hashLine(line)} ${line}`)
		.join('\n')
}

// Parse a "42:abc" ref string into { line, hash }.
function parseRef(ref: string): HashlineRef | null {
	const match = ref.match(/^(\d+):([0-9a-zA-Z]{3})$/)
	return match ? { line: parseInt(match[1]!, 10), hash: match[2]! } : null
}

// Validate a ref against actual file lines. Returns error string or null.
function validateRef(ref: HashlineRef, lines: string[]): string | null {
	if (ref.line < 1 || ref.line > lines.length) {
		return `Line ${ref.line} out of range (file has ${lines.length} lines)`
	}
	const actual = hashLine(lines[ref.line - 1]!)
	if (actual !== ref.hash) {
		return `Hash mismatch at line ${ref.line}: expected ${ref.hash}, got ${actual} (content: "${lines[ref.line - 1]!.slice(0, 60)}")`
	}
	return null
}

// Format lines with hashline prefixes, showing a window around a range.
function formatContext(lines: string[], start: number, end: number, contextLines: number): string {
	const from = Math.max(0, start - contextLines)
	const to = Math.min(lines.length, end + contextLines)
	const width = String(to).length
	return lines.slice(from, to).map((line, i) =>
		`${String(from + i + 1).padStart(width)}:${hashLine(line)} ${line}`,
	).join('\n')
}

// Split content into lines, dropping a trailing empty line from "\n"-terminated files.
function toLines(content: string): string[] {
	const lines = content.split('\n')
	if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
	return lines
}

export const hashline = { hashLine, formatHashlines, parseRef, validateRef, formatContext, toLines }
