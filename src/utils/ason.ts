// ASON — A Saner Object Notation
// See docs/ason.md — keep it in sync when changing this file.

/** Symbol key for attaching comments to AsonObject/AsonArray. */
export const COMMENTS = Symbol('comments')

/** Any value representable in ASON. */
export type AsonValue =
	| string | number | boolean | null | undefined
	| AsonArray
	| AsonObject

/** Array with optional comment metadata per element. */
export type AsonArray = AsonValue[] & { [COMMENTS]?: (string | undefined)[] }
/** Object with optional comment metadata per key. */
export type AsonObject = { [key: string]: AsonValue; [COMMENTS]?: Record<string, string> }

// --- Stringify ---

function quoteString(s: string): string {
	const escaped = s
		.replace(/\\/g, '\\\\')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t')
	const hasSingle = s.includes("'")
	const hasDouble = s.includes('"')
	if (hasSingle && !hasDouble) return `"${escaped}"`
	return `'${escaped.replace(/'/g, "\\'")}'`
}

const IDENT_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/

function quoteKey(key: string): string {
	return IDENT_RE.test(key) ? key : quoteString(key)
}

function indentComment(comment: string, pad: string): string {
	const lines = comment.replace(/\n$/, '').split('\n')
	return lines.map(l => l ? pad + l : '').join('\n')
}

function stringifyValue(obj: unknown, col: number, depth: number, maxWidth: number): string {
	if (obj === null) return 'null'
	if (obj === undefined) return 'undefined'
	if (typeof obj === 'boolean') return obj ? 'true' : 'false'
	if (typeof obj === 'number') {
		if (Number.isNaN(obj)) return 'NaN'
		if (obj === Infinity) return 'Infinity'
		if (obj === -Infinity) return '-Infinity'
		return String(obj)
	}
	if (typeof obj === 'string') return quoteString(obj)

	if (Array.isArray(obj)) {
		if (obj.length === 0) return '[]'
		const comments = maxWidth < Infinity ? (obj as AsonArray)[COMMENTS] : undefined
		const items = obj.map((v) => stringifyValue(v, 0, depth, maxWidth))
		const inline = `[${items.join(', ')}]`
		if (!comments && col + inline.length <= maxWidth && !inline.includes('\n')) return inline
		const childDepth = depth + 1
		const pad = '  '.repeat(childDepth)
		const lines = obj.map((v, i) => {
			const comment = comments?.[i]
			const prefix = comment ? indentComment(comment, pad) + '\n' : ''
			return `${prefix}${pad}${stringifyValue(v, pad.length, childDepth, maxWidth)}${i < obj.length - 1 ? ',' : ''}`
		})
		return `[\n${lines.join('\n')}\n${'  '.repeat(depth)}]`
	}

	if (typeof obj === 'object') {
		const rec = obj as AsonObject
		const keys = Object.keys(rec)
		if (keys.length === 0) return '{}'
		const comments = maxWidth < Infinity ? rec[COMMENTS] : undefined
		const pairs = keys.map(
			(k) => `${quoteKey(k)}: ${stringifyValue(rec[k], 0, depth, maxWidth)}`,
		)
		const inline = `{ ${pairs.join(', ')} }`
		if (!comments && col + inline.length <= maxWidth && !inline.includes('\n')) return inline
		const childDepth = depth + 1
		const pad = '  '.repeat(childDepth)
		const lines = keys.map((k, i) => {
			const comment = comments?.[k]
			const prefix = comment ? indentComment(comment, pad) + '\n' : ''
			const keyPrefix = `${pad}${quoteKey(k)}: `
			const val = stringifyValue(rec[k], keyPrefix.length, childDepth, maxWidth)
			return `${prefix}${keyPrefix}${val}${i < keys.length - 1 ? ',' : ''}`
		})
		return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`
	}

	throw new Error(`TODO: unsupported type ${typeof obj}`)
}

export type StringifyMode = 'short' | 'smart' | 'long'

/** Convert a value to an ASON string. Mode: 'smart' (default, 80-col wrap), 'short' (single line), 'long' (always expanded). */
export function stringify(obj: unknown, mode: StringifyMode = 'smart'): string {
	const maxWidth = mode === 'short' ? Infinity : mode === 'long' ? 0 : 80
	return stringifyValue(obj, 0, 0, maxWidth)
}

// --- Parse ---

type Ctx = { buf: string; pos: number; comments?: boolean }

class ParseError extends Error {
	pos: number
	constructor(msg: string, pos: number) {
		super(msg)
		this.pos = pos
	}
}

function fail(ctx: Ctx, msg: string): never {
	let line = 1, col = 1
	for (const c of ctx.buf.slice(0, ctx.pos)) {
		if (c === '\n') { line++; col = 1 } else col++
	}
	const lineText = ctx.buf.split('\n')[line - 1] ?? ''
	const pad = lineText.slice(0, col - 1).replace(/[^\t]/g, ' ')
	throw new ParseError(
		`${msg} at ${line}:${col}:\n    ${lineText}\n    ${pad}^`,
		ctx.pos,
	)
}

function isIdent(ch: string): boolean {
	return /[a-zA-Z0-9_$]/.test(ch)
}

function skipWhite(ctx: Ctx): string {
	let collected = ''
	let newlines = 0
	while (ctx.pos < ctx.buf.length) {
		const ch = peek(ctx)
		if (ch === '\n') { ctx.pos++; newlines++; continue }
		if (ch === ' ' || ch === '\t' || ch === '\r') { ctx.pos++; continue }
		if (ch === '/' && peek2(ctx) === '/') {
			const start = ctx.pos
			ctx.pos += 2
			while (ctx.pos < ctx.buf.length && peek(ctx) !== '\n') ctx.pos++
			if (ctx.pos < ctx.buf.length) ctx.pos++ // include \n
			if (ctx.comments) {
				if (newlines >= 2) collected += '\n'
				collected += ctx.buf.slice(start, ctx.pos)
			}
			newlines = 0
			continue
		}
		if (ch === '/' && peek2(ctx) === '*') {
			const start = ctx.pos
			ctx.pos += 2
			while (ctx.pos < ctx.buf.length) {
				if (peek(ctx) === '*' && peek2(ctx) === '/') { ctx.pos += 2; break }
				ctx.pos++
			}
			if (ctx.comments) {
				if (newlines >= 2) collected += '\n'
				collected += ctx.buf.slice(start, ctx.pos)
			}
			newlines = 0
			continue
		}
		break
	}
	return collected
}

function peek(ctx: Ctx): string { return ctx.buf[ctx.pos] ?? '' }

function peek2(ctx: Ctx): string { return ctx.buf[ctx.pos + 1] ?? '' }

function eat(ctx: Ctx, ch: string): void {
	if (peek(ctx) !== ch) fail(ctx, `Expected '${ch}', got '${peek(ctx) || 'EOF'}'`)
	ctx.pos++
}

function eatWord(ctx: Ctx, word: string): void {
	for (const c of word) eat(ctx, c)
	if (isIdent(peek(ctx))) fail(ctx, `Unexpected character after '${word}'`)
}

function parseString(ctx: Ctx, quote: string): string {
	ctx.pos++ // skip opening quote
	let result = ''
	while (ctx.pos < ctx.buf.length) {
		const ch = peek(ctx)
		if (ch === '\\') {
			ctx.pos++
			const esc = peek(ctx)
			if (esc === 'n') result += '\n'
			else if (esc === 't') result += '\t'
			else if (esc === 'r') result += '\r'
			else if (esc === 'b') result += '\b'
			else if (esc === 'f') result += '\f'
			else if (esc === 'u') {
				let hex = ''
				for (let i = 0; i < 4; i++) {
					ctx.pos++
					if (!/[0-9a-fA-F]/.test(peek(ctx))) fail(ctx, 'Invalid unicode escape')
					hex += peek(ctx)
				}
				result += String.fromCharCode(parseInt(hex, 16))
			} else result += esc
			ctx.pos++
			continue
		}
		if (ch === quote) { ctx.pos++; return result }
		result += ch
		ctx.pos++
	}
	fail(ctx, 'Unterminated string')
}

const NUM_RE = /-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/y

function parseNumber(ctx: Ctx): number {
	NUM_RE.lastIndex = ctx.pos
	const m = NUM_RE.exec(ctx.buf)
	if (!m) fail(ctx, 'Invalid number')
	ctx.pos = NUM_RE.lastIndex
	return Number(m[0])
}

function parseKey(ctx: Ctx): string {
	skipWhite(ctx)
	const ch = peek(ctx)
	if (ch === "'" || ch === '"') return parseString(ctx, ch)
	const start = ctx.pos
	while (isIdent(peek(ctx))) ctx.pos++
	if (ctx.pos === start) fail(ctx, 'Expected object key')
	return ctx.buf.slice(start, ctx.pos)
}

function parseObject(ctx: Ctx): AsonObject {
	ctx.pos++ // skip {
	const obj: AsonObject = {}
	let commentMap: Record<string, string> | undefined
	while (true) {
		const comment = skipWhite(ctx)
		if (peek(ctx) === '}') { ctx.pos++; break }
		const key = parseKey(ctx)
		if (comment) {
			commentMap ??= {}
			commentMap[key] = comment
		}
		skipWhite(ctx); eat(ctx, ':')
		obj[key] = parseAny(ctx)
		skipWhite(ctx)
		if (peek(ctx) === ',') ctx.pos++
	}
	if (commentMap) obj[COMMENTS] = commentMap
	return obj
}

function parseArray(ctx: Ctx): AsonArray {
	ctx.pos++ // skip [
	const arr: AsonArray = [] as AsonArray
	let commentArr: (string | undefined)[] | undefined
	while (true) {
		const comment = skipWhite(ctx)
		if (peek(ctx) === ']') { ctx.pos++; break }
		if (comment) {
			commentArr ??= []
			commentArr[arr.length] = comment
		}
		arr.push(parseAny(ctx))
		skipWhite(ctx)
		if (peek(ctx) === ',') ctx.pos++
	}
	if (commentArr) arr[COMMENTS] = commentArr
	return arr
}

function parseAny(ctx: Ctx): AsonValue {
	skipWhite(ctx)
	const ch = peek(ctx)
	if (ch === '{') return parseObject(ctx)
	if (ch === '[') return parseArray(ctx)
	if (ch === "'" || ch === '"') return parseString(ctx, ch)
	if (ch === '-') {
		if (peek2(ctx) === 'I') { eatWord(ctx, '-Infinity'); return -Infinity }
		return parseNumber(ctx)
	}
	if (/[0-9]/.test(ch)) return parseNumber(ctx)
	if (ch === 't') { eatWord(ctx, 'true'); return true }
	if (ch === 'f') { eatWord(ctx, 'false'); return false }
	if (ch === 'n') { eatWord(ctx, 'null'); return null }
	if (ch === 'u') { eatWord(ctx, 'undefined'); return undefined }
	if (ch === 'N') { eatWord(ctx, 'NaN'); return NaN }
	if (ch === 'I') { eatWord(ctx, 'Infinity'); return Infinity }
	fail(ctx, 'Unexpected token')
}

/** Parse a single ASON value. Pass `{ comments: true }` to preserve comments as `[COMMENTS]` metadata. */
export function parse(str: string, opts?: { comments?: boolean }): AsonValue {
	const ctx: Ctx = { buf: str, pos: 0, comments: opts?.comments }
	const value = parseAny(ctx)
	skipWhite(ctx)
	if (ctx.pos < ctx.buf.length) fail(ctx, 'Unexpected content after value')
	return value
}

/** Parse multiple ASON values from a single string (like JSONL — one value per line or concatenated). */
export function parseAll(str: string): AsonValue[] {
	const ctx: Ctx = { buf: str, pos: 0 }
	const results: AsonValue[] = []
	skipWhite(ctx)
	while (ctx.pos < ctx.buf.length) {
		results.push(parseAny(ctx))
		skipWhite(ctx)
	}
	return results
}

/** Yields newline-delimited lines from a byte stream.
 *  split('\n') always produces a trailing element after the last \n;
 *  pop() keeps that incomplete fragment in buf for the next chunk.
 *  e.g. "a\nb\nc" → ["a","b","c"] → yield "a","b", buf="c" */
async function* streamLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder()
	let buf = ''
	for await (const chunk of stream) {
		buf += decoder.decode(chunk, { stream: true })
		const lines = buf.split('\n')
		buf = lines.pop()!
		for (const line of lines) yield line
	}
	if (buf) yield buf
}

/** Yields parsed ASON values from a byte stream, one per newline-delimited record.
 *  The first line silently ignores parse errors (the stream may start mid-record). */
export async function* parseStream(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<AsonValue> {
	let first = true
	for await (const line of streamLines(stream)) {
		if (!line.trim()) continue
		if (first) {
			first = false
			try { yield parse(line) } catch {}
		} else {
			yield parse(line)
		}
	}
}

export default { stringify, parse, parseAll, parseStream, COMMENTS }
export type { ParseError }
