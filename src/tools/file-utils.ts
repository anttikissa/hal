import { createHash } from 'crypto'
import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import { ason } from '../utils/ason.ts'

const HOME = homedir()
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const BASE = ALPHA.length
const locks = new Map<string, Promise<void>>()

export interface HashlineRef {
	line: number
	hash: string
}

export function resolvePath(path: string | undefined, cwd: string): string {
	if (!path?.trim()) return cwd
	if (path.startsWith('~/')) path = HOME + path.slice(1)
	return isAbsolute(path) ? path : resolve(cwd, path)
}

export function hashLine(line: string): string {
	const norm = line.trim().replace(/\s+/g, ' ')
	const md5 = createHash('md5').update(norm).digest()
	const n = (md5[0] << 16) | (md5[1] << 8) | md5[2]
	return ALPHA[n % BASE] + ALPHA[Math.floor(n / BASE) % BASE] + ALPHA[Math.floor(n / (BASE * BASE)) % BASE]
}

export function formatHashlines(content: string, start = 1, end?: number): string {
	const lines = content.split('\n')
	const s = Math.max(1, start)
	const e = Math.min(lines.length, end ?? lines.length)
	const width = String(e).length
	return lines.slice(s - 1, e)
		.map((line, i) => `${String(s + i).padStart(width)}:${hashLine(line)} ${line}`)
		.join('\n')
}

export function parseRef(ref: string): HashlineRef | null {
	const match = ref.match(/^(\d+):([0-9a-zA-Z]{3})$/)
	return match ? { line: parseInt(match[1], 10), hash: match[2] } : null
}

export function validateRef(ref: HashlineRef, lines: string[]): string | null {
	if (ref.line < 1 || ref.line > lines.length) {
		return `Line ${ref.line} out of range (file has ${lines.length} lines)`
	}
	const actual = hashLine(lines[ref.line - 1])
	if (actual !== ref.hash) {
		return `Hash mismatch at line ${ref.line}: expected ${ref.hash}, got ${actual} (content: ${ason.stringify(lines[ref.line - 1].slice(0, 60))})`
	}
	return null
}

export function formatContext(lines: string[], start: number, end: number, contextLines: number): string {
	const from = Math.max(0, start - contextLines)
	const to = Math.min(lines.length, end + contextLines)
	const width = String(to).length
	return lines.slice(from, to).map((line, i) =>
		`${String(from + i + 1).padStart(width)}:${hashLine(line)} ${line}`,
	).join('\n')
}

export function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(path) ?? Promise.resolve()
	const result = prev.then(fn, fn)
	const done = result.then(() => {}, () => {})
	locks.set(path, done)
	done.then(() => {
		if (locks.get(path) === done) locks.delete(path)
	})
	return result
}
