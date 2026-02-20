import { createHash } from "crypto"
import { stringify } from "./utils/ason.ts"

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
const BASE = ALPHABET.length

function normalize(line: string): string {
	return line.trim().replace(/\s+/g, " ")
}

export function hashLine(line: string): string {
	const norm = normalize(line)
	const md5 = createHash("md5").update(norm).digest()
	const n = (md5[0] << 16) | (md5[1] << 8) | md5[2]
	return ALPHABET[n % BASE] + ALPHABET[Math.floor(n / BASE) % BASE] + ALPHABET[Math.floor(n / (BASE * BASE)) % BASE]
}

export function formatWithHashlines(content: string): string {
	const lines = content.split("\n")
	const width = String(lines.length).length
	return lines.map((line, i) => {
		const num = String(i + 1).padStart(width)
		return `${num}:${hashLine(line)} ${line}`
	}).join("\n")
}

export function parseRef(ref: string): { line: number; hash: string } | null {
	const m = ref.match(/^(\d+):([0-9a-zA-Z]{3})$/)
	if (!m) return null
	return { line: parseInt(m[1], 10), hash: m[2] }
}

export function validateRef(ref: { line: number; hash: string }, lines: string[]): string | null {
	if (ref.line < 1 || ref.line > lines.length) {
		return `Line ${ref.line} out of range (file has ${lines.length} lines)`
	}
	const actual = hashLine(lines[ref.line - 1])
	if (actual !== ref.hash) {
		return `Hash mismatch at line ${ref.line}: expected ${ref.hash}, got ${actual} (content: ${stringify(lines[ref.line - 1].slice(0, 60))})`
	}
	return null
}

export function applyEdit(
	content: string, startRef: string, endRef: string, newContent: string
): { result?: string; error?: string } {
	const start = parseRef(startRef)
	if (!start) return { error: `Invalid start reference: ${startRef}` }
	const end = parseRef(endRef)
	if (!end) return { error: `Invalid end reference: ${endRef}` }
	const lines = content.split("\n")
	const startErr = validateRef(start, lines)
	if (startErr) return { error: startErr }
	const endErr = validateRef(end, lines)
	if (endErr) return { error: endErr }
	if (start.line > end.line) return { error: `Start line ${start.line} is after end line ${end.line}` }

	const newLines = newContent === "" ? [] : newContent.split("\n")
	return { result: [...lines.slice(0, start.line - 1), ...newLines, ...lines.slice(end.line)].join("\n") }
}

export function applyInsert(
	content: string, afterRef: string, newContent: string
): { result?: string; error?: string } {
	const lines = content.split("\n")
	const newLines = newContent.split("\n")
	if (afterRef === "0:000") return { result: [...newLines, ...lines].join("\n") }
	const ref = parseRef(afterRef)
	if (!ref) return { error: `Invalid reference: ${afterRef}` }
	const err = validateRef(ref, lines)
	if (err) return { error: err }
	return { result: [...lines.slice(0, ref.line), ...newLines, ...lines.slice(ref.line)].join("\n") }
}
