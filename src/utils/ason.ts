// ASON — A Saner Object Notation
//
// Like JSON, but human-friendly:
//   - stringify() produces readable output ({ foo: [123, 'a'] })
//   - prettier-like output (don't indent if object fits in 80 chars)
//   - Keys are unquoted when possible: { name: 'hal', version: 1 }
//   - Comments: // line comments and /* block comments */
//   - Streaming support built-in (like JSONL — multiple values in one stream)
//   - Backwards compatible: any JSON or JSONL file is valid ASON
//
// API:
//   stringify(obj)      - object → ASON string
//   parse(str)          - ASON string → object
//   parseAll(str)       - ASON string → array of values (JSONL-style)
//   parseStream(stream) - async generator yielding values from a byte stream

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

function stringifyValue(obj: any, col: number, depth: number, maxWidth: number): string {
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
		const items = obj.map((v) => stringifyValue(v, 0, depth, maxWidth))
		const inline = `[${items.join(', ')}]`
		if (col + inline.length <= maxWidth && !inline.includes('\n')) return inline
		const childDepth = depth + 1
		const pad = '  '.repeat(childDepth)
		const lines = obj.map(
			(v, i) => `${pad}${stringifyValue(v, pad.length, childDepth, maxWidth)}${i < obj.length - 1 ? ',' : ''}`,
		)
		return `[\n${lines.join('\n')}\n${'  '.repeat(depth)}]`
	}

	if (typeof obj === 'object') {
		const keys = Object.keys(obj)
		if (keys.length === 0) return '{}'
		const pairs = keys.map(
			(k) => `${quoteKey(k)}: ${stringifyValue(obj[k], 0, depth, maxWidth)}`,
		)
		const inline = `{ ${pairs.join(', ')} }`
		if (col + inline.length <= maxWidth && !inline.includes('\n')) return inline
		const childDepth = depth + 1
		const pad = '  '.repeat(childDepth)
		const lines = keys.map((k, i) => {
			const prefix = `${pad}${quoteKey(k)}: `
			const val = stringifyValue(obj[k], prefix.length, childDepth, maxWidth)
			return `${prefix}${val}${i < keys.length - 1 ? ',' : ''}`
		})
		return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`
	}

	throw new Error(`TODO: unsupported type ${typeof obj}`)
}

export type StringifyMode = 'short' | 'smart' | 'long'

export function stringify(obj: any, mode: StringifyMode = 'smart'): string {
	const maxWidth = mode === 'short' ? Infinity : mode === 'long' ? 0 : 80
	return stringifyValue(obj, 0, 0, maxWidth)
}

// --- Parse ---

type Ctx = { buf: string; pos: number }


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


function isIdent(ch: string | undefined): boolean {
	if (!ch) return false
	const c = ch.charCodeAt(0)
	// 0-9, A-Z, a-z, _, $
	return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36
}

function skipWhite(ctx: Ctx): void {
	while (ctx.pos < ctx.buf.length) {
		const ch = peek(ctx)
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { ctx.pos++; continue }
		if (ch === '/' && peek2(ctx) === '/') {
			ctx.pos += 2
			while (ctx.pos < ctx.buf.length && peek(ctx) !== '\n') ctx.pos++
			continue
		}
		if (ch === '/' && peek2(ctx) === '*') {
			ctx.pos += 2
			while (ctx.pos < ctx.buf.length) {
				if (peek(ctx) === '*' && peek2(ctx) === '/') { ctx.pos += 2; break }
				ctx.pos++
			}
			continue
		}
		break
	}
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
			else result += esc
			ctx.pos++
			continue
		}
		if (ch === quote) { ctx.pos++; return result }
		result += ch
		ctx.pos++
	}
	fail(ctx, 'Unterminated string')
}

function parseNumber(ctx: Ctx): number {
	const start = ctx.pos
	if (peek(ctx) === '-') ctx.pos++
	while (peek(ctx) >= '0' && peek(ctx) <= '9' || peek(ctx) === '.') ctx.pos++
	if (peek(ctx) === 'e' || peek(ctx) === 'E') {
		ctx.pos++
		if (peek(ctx) === '+' || peek(ctx) === '-') ctx.pos++
		while (peek(ctx) >= '0' && peek(ctx) <= '9') ctx.pos++
	}
	const num = Number(ctx.buf.slice(start, ctx.pos))
	if (isNaN(num)) fail(ctx, 'Invalid number')
	return num
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


function parseObject(ctx: Ctx): Record<string, any> {
	ctx.pos++ // skip {
	const obj: Record<string, any> = {}
	while (true) {
		skipWhite(ctx)
		if (peek(ctx) === '}') { ctx.pos++; return obj }
		const key = parseKey(ctx)
		skipWhite(ctx); eat(ctx, ':')
		obj[key] = parseAny(ctx)
		skipWhite(ctx)
		if (peek(ctx) === ',') ctx.pos++
	}
}

function parseArray(ctx: Ctx): any[] {
	ctx.pos++ // skip [
	const arr: any[] = []
	while (true) {
		skipWhite(ctx)
		if (peek(ctx) === ']') { ctx.pos++; return arr }
		arr.push(parseAny(ctx))
		skipWhite(ctx)
		if (peek(ctx) === ',') ctx.pos++
	}
}

function parseAny(ctx: Ctx): any {
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


export function parse(str: string): any {
	const ctx: Ctx = { buf: str, pos: 0 }
	const value = parseAny(ctx)
	skipWhite(ctx)
	if (ctx.pos < ctx.buf.length) fail(ctx, 'Unexpected content after value')
	return value
}

export function parseAll(str: string): any[] {
	const ctx: Ctx = { buf: str, pos: 0 }
	const results: any[] = []
	skipWhite(ctx)
	while (ctx.pos < ctx.buf.length) {
		results.push(parseAny(ctx))
		skipWhite(ctx)
	}
	return results
}

export async function* parseStream(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<any> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let buf = ''

	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		buf += decoder.decode(value, { stream: true })
		const lines = buf.split('\n')
		buf = lines.pop()!
		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed) continue
			yield parse(trimmed)
		}
	}

	const trimmed = buf.trim()
	if (trimmed) yield parse(trimmed)
}

export default { stringify, parse, parseAll, parseStream }
export type { ParseError }
