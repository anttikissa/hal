// ASON — A Saner Object Notation
// Goal: be as JavaScript-compatible as practical while staying easy to read
// and stream. That means JS-like numbers (`.5`, `1e10`, `Infinity`,
// `undefined`), JS-like strings (single, double, backtick), and JS-like
// commas: separators are required, trailing commas are allowed.
// See docs/ason.md — keep it in sync when changing this file.

/** Symbol key for attaching comments to AsonObject/AsonArray. */
export const COMMENTS = Symbol('comments')

/** Any value representable in ASON. */
export type AsonValue = string | number | boolean | null | undefined | AsonArray | AsonObject

/** Array with optional comment metadata per element. */
export type AsonArray = AsonValue[] & { [COMMENTS]?: (string | undefined)[] }
/** Object with optional comment metadata per key. */
export type AsonObject = {
	[key: string]: AsonValue
	[COMMENTS]?: Record<string, string>
}

// --- Stringify ---

function quoteString(s: string, multiline = false): string {
	if (multiline && s.includes('\n')) {
		const escaped = s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
		return `\`${escaped}\``
	}
	const escaped = s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
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
	return lines.map((l) => (l ? pad + l : '')).join('\n')
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
	if (typeof obj === 'string') return quoteString(obj, maxWidth < Infinity)

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
		const pairs = keys.map((k) => `${quoteKey(k)}: ${stringifyValue(rec[k], 0, depth, maxWidth)}`)
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
	let line = 1,
		col = 1
	for (const c of ctx.buf.slice(0, ctx.pos)) {
		if (c === '\n') {
			line++
			col = 1
		} else col++
	}
	const lineText = ctx.buf.split('\n')[line - 1] ?? ''
	const pad = lineText.slice(0, col - 1).replace(/[^\t]/g, ' ')
	throw new ParseError(`${msg} at ${line}:${col}:\n    ${lineText}\n    ${pad}^`, ctx.pos)
}

function isIdent(c: string): boolean {
	return /[a-zA-Z0-9_$]/.test(c)
}

function skipWhite(ctx: Ctx): string {
	let collected = ''
	let newlines = 0
	while (ctx.pos < ctx.buf.length) {
		const c = peek(ctx)
		if (c === '\n') {
			ctx.pos++
			newlines++
			continue
		}
		if (c === ' ' || c === '\t' || c === '\r') {
			ctx.pos++
			continue
		}
		if (c === '/' && peek2(ctx) === '/') {
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
		if (c === '/' && peek2(ctx) === '*') {
			const start = ctx.pos
			ctx.pos += 2
			while (ctx.pos < ctx.buf.length) {
				if (peek(ctx) === '*' && peek2(ctx) === '/') {
					ctx.pos += 2
					break
				}
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

function peek(ctx: Ctx): string {
	return ctx.buf[ctx.pos] ?? ''
}

function peek2(ctx: Ctx): string {
	return ctx.buf[ctx.pos + 1] ?? ''
}

// If the next character is 'c', eat it and return true; if it isn't, return false or throw ParseError
// if `required` is true.
function eat(ctx: Ctx, c: string, required = false): boolean {
	if (peek(ctx) !== c) {
		if (required) fail(ctx, `Expected '${c}', got '${peek(ctx) || 'EOF'}'`)
		return false
	}
	ctx.pos++
	return true
}

function eatWord(ctx: Ctx, word: string): void {
	for (const c of word) eat(ctx, c, true)
	if (isIdent(peek(ctx))) fail(ctx, `Unexpected character after '${word}'`)
}

function parseString(ctx: Ctx, quote: string): string {
	ctx.pos++ // skip opening quote
	const start = ctx.pos
	const buf = ctx.buf
	const qc = quote.charCodeAt(0)
	const checkTemplateDollar = quote === '`'

	// Fast path: scan for closing quote without escapes
	let pos = ctx.pos
	while (pos < buf.length) {
		const cc = buf.charCodeAt(pos)
		if (cc === 0x5c) break // backslash — fall through to slow path
		if (cc === qc) {
			ctx.pos = pos + 1
			return buf.slice(start, pos)
		}
		if (checkTemplateDollar && cc === 0x24 && buf.charCodeAt(pos + 1) === 0x7b) {
			ctx.pos = pos
			fail(ctx, 'Template interpolation is not supported')
		}
		pos++
	}

	// Slow path: has escapes — build from segments
	const segments: string[] = []
	let segStart = start
	ctx.pos = pos
	while (ctx.pos < buf.length) {
		const cc = buf.charCodeAt(ctx.pos)
		if (cc === 0x5c) {
			// backslash
			segments.push(buf.slice(segStart, ctx.pos))
			ctx.pos++
			const esc = buf.charCodeAt(ctx.pos)
			if (esc === 0x0d) {
				if (buf.charCodeAt(ctx.pos + 1) === 0x0a) ctx.pos++
			} else if (esc === 0x0a || esc === 0x2028 || esc === 0x2029) {
				// JSON5 string continuations swallow the escaped line break.
			} else if (esc === 0x6e)
				segments.push('\n') // n
			else if (esc === 0x74)
				segments.push('\t') // t
			else if (esc === 0x72)
				segments.push('\r') // r
			else if (esc === 0x76)
				segments.push('\v') // v
			else if (esc === 0x30)
				segments.push('\0') // 0
			else if (esc === 0x62)
				segments.push('\b') // b
			else if (esc === 0x66)
				segments.push('\f') // f
			else if (esc === 0x78) {
				// x
				const hex = buf.slice(ctx.pos + 1, ctx.pos + 3)
				if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail(ctx, 'Invalid hex escape')
				segments.push(String.fromCharCode(parseInt(hex, 16)))
				ctx.pos += 2
			} else if (esc === 0x75) {
				// u
				const hex = buf.slice(ctx.pos + 1, ctx.pos + 5)
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(ctx, 'Invalid unicode escape')
				segments.push(String.fromCharCode(parseInt(hex, 16)))
				ctx.pos += 4
			} else segments.push(buf[ctx.pos]!)
			ctx.pos++
			segStart = ctx.pos
			continue
		}
		if (cc === qc) {
			segments.push(buf.slice(segStart, ctx.pos))
			ctx.pos++
			return segments.join('')
		}
		if (checkTemplateDollar && cc === 0x24 && buf.charCodeAt(ctx.pos + 1) === 0x7b) {
			fail(ctx, 'Template interpolation is not supported')
		}
		ctx.pos++
	}
	fail(ctx, 'Unterminated string')
}

const HEX_RE = /[+-]?0[xX][0-9a-fA-F]+/y
const NUM_RE = /[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y

function parseNumber(ctx: Ctx): number {
	HEX_RE.lastIndex = ctx.pos
	const hex = HEX_RE.exec(ctx.buf)
	if (hex) {
		ctx.pos = HEX_RE.lastIndex
		const sign = hex[0][0] === '-' ? -1 : 1
		return sign * parseInt(hex[0].replace(/^[+-]/, ''), 16)
	}
	NUM_RE.lastIndex = ctx.pos
	const m = NUM_RE.exec(ctx.buf)
	if (!m) fail(ctx, 'Invalid number')
	ctx.pos = NUM_RE.lastIndex
	return Number(m[0])
}

function parseKey(ctx: Ctx): string {
	skipWhite(ctx)
	const c = peek(ctx)
	if (c === "'" || c === '"') return parseString(ctx, c)
	const start = ctx.pos
	while (ctx.pos < ctx.buf.length) {
		const c = peek(ctx)
		if (c === ':' || c === ',' || c === '}' || c === ']' || c === ' ' || c === '\t' || c === '\r' || c === '\n') break
		if (c === '/' && (peek2(ctx) === '/' || peek2(ctx) === '*')) break
		ctx.pos++
	}
	if (ctx.pos === start) fail(ctx, 'Expected object key')
	return ctx.buf.slice(start, ctx.pos)
}

function parseObject(ctx: Ctx): AsonObject {
	ctx.pos++ // skip {
	const obj: AsonObject = {}
	let commentMap: Record<string, string> | undefined
	while (true) {
		const comment = skipWhite(ctx)
		if (eat(ctx, '}')) break
		const key = parseKey(ctx)
		if (comment) {
			commentMap ??= {}
			commentMap[key] = comment
		}
		skipWhite(ctx)
		eat(ctx, ':', true)
		obj[key] = parseAny(ctx)
		skipWhite(ctx)
		if (eat(ctx, '}')) break
		if (!eat(ctx, ',')) fail(ctx, "Expected ',' or '}'")
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
		if (eat(ctx, ']')) break
		if (comment) {
			commentArr ??= []
			commentArr[arr.length] = comment
		}
		arr.push(parseAny(ctx))
		skipWhite(ctx)
		if (eat(ctx, ']')) break
		if (!eat(ctx, ',')) fail(ctx, "Expected ',' or ']'")
	}
	if (commentArr) arr[COMMENTS] = commentArr
	return arr
}

function parseAny(ctx: Ctx): AsonValue {
	skipWhite(ctx)
	const c = peek(ctx)
	if (c === '{') return parseObject(ctx)
	if (c === '[') return parseArray(ctx)
	if (c === "'" || c === '"' || c === '`') return parseString(ctx, c)
	if (c === '-' || c === '+') {
		if (peek2(ctx) === 'I') {
			eatWord(ctx, c + 'Infinity')
			return c === '-' ? -Infinity : Infinity
		}
		if (peek2(ctx) === 'N') {
			eatWord(ctx, c + 'NaN')
			return NaN
		}
		return parseNumber(ctx)
	}
	if (/[0-9.]/.test(c)) return parseNumber(ctx)
	if (c === 't') {
		eatWord(ctx, 'true')
		return true
	}
	if (c === 'f') {
		eatWord(ctx, 'false')
		return false
	}
	if (c === 'n') {
		eatWord(ctx, 'null')
		return null
	}
	if (c === 'u') {
		eatWord(ctx, 'undefined')
		return undefined
	}
	if (c === 'N') {
		eatWord(ctx, 'NaN')
		return NaN
	}
	if (c === 'I') {
		eatWord(ctx, 'Infinity')
		return Infinity
	}
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
export async function* parseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<AsonValue> {
	let first = true
	for await (const line of streamLines(stream)) {
		if (!line.trim()) continue
		if (first) {
			first = false
			try {
				yield parse(line)
			} catch {}
		} else {
			yield parse(line)
		}
	}
}

export const ason = { stringify, parse, parseAll, parseStream, COMMENTS }
export default ason
export type { ParseError }
