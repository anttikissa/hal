// ASON — A Saner Object Notation
//
// Goal: be as JavaScript-compatible as practical while staying easy to read
// and stream. That means JS-like numbers (`.5`, `1e10`, `Infinity`, `123n`,
// `undefined`), JS-like strings (single, double, backtick), and JS-like
// commas: separators are required, trailing commas are allowed.
// Format: tasks/8/ason.md. Comments are accepted but not preserved.
//
// License: MIT

/** Any value representable in ASON. */
export type AsonValue = string | number | bigint | boolean | null | undefined | AsonArray | AsonObject
export type AsonArray = AsonValue[]
export type AsonObject = { [key: string]: AsonValue }

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

// Tabs encode one ASON indentation level; keep wrapping compatible with the former two-column indentation.
// In long mode, skip the unused inline candidate: computing both forms at every level is exponential.
function renderCollection(open: string, close: string, inline: string, col: number, depth: number, maxWidth: number, buildLines: (pad: string, childDepth: number) => string[]): string {
	if (maxWidth > 0 && col + inline.length <= maxWidth && !inline.includes('\n')) return inline
	const childDepth = depth + 1
	return `${open}\n${buildLines('\t'.repeat(childDepth), childDepth).join('\n')}\n${'\t'.repeat(depth)}${close}`
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
	if (typeof obj === 'bigint') return `${obj}n`
	if (typeof obj === 'string') return quoteString(obj, maxWidth < Infinity)

	if (Array.isArray(obj)) {
		if (obj.length === 0) return '[]'
		const inline = maxWidth === 0 ? '' : `[${obj.map((v) => stringifyValue(v, 0, depth, maxWidth)).join(', ')}]`
		return renderCollection('[', ']', inline, col, depth, maxWidth, (pad, childDepth) =>
			obj.map((v, i) => `${pad}${stringifyValue(v, childDepth * 2, childDepth, maxWidth)}${i < obj.length - 1 ? ',' : ''}`),
		)
	}

	if (typeof obj === 'object') {
		const rec = obj as AsonObject
		const keys = Object.keys(rec)
		if (keys.length === 0) return '{}'
		const inline = maxWidth === 0 ? '' : `{ ${keys.map((k) => `${quoteKey(k)}: ${stringifyValue(rec[k], 0, depth, maxWidth)}`).join(', ')} }`
		return renderCollection('{', '}', inline, col, depth, maxWidth, (pad, childDepth) =>
			keys.map((k, i) => `${pad}${quoteKey(k)}: ${stringifyValue(rec[k], childDepth * 2 + `${quoteKey(k)}: `.length, childDepth, maxWidth)}${i < keys.length - 1 ? ',' : ''}`),
		)
	}

	throw new Error(`ASON cannot represent ${typeof obj}`)
}

export type StringifyMode = 'short' | 'smart' | 'long'

/** Convert a value to an ASON string. Mode: 'smart' (default, 80-col wrap), 'short' (single line), 'long' (always expanded). */
function stringify(obj: unknown, mode: StringifyMode = 'smart'): string {
	const maxWidth = mode === 'short' ? Infinity : mode === 'long' ? 0 : 80
	return stringifyValue(obj, 0, 0, maxWidth)
}

// --- Parse ---

type Ctx = { buf: string; pos: number }
export type ParseError = Error & { pos: number }

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
	throw Object.assign(new Error(`${msg} at ${line}:${col}:\n    ${lineText}\n    ${pad}^`), { pos: ctx.pos }) as ParseError
}

function isIdent(c: string): boolean {
	return /[a-zA-Z0-9_$]/.test(c)
}

function skipWhite(ctx: Ctx): void {
	while (ctx.pos < ctx.buf.length) {
		const c = peek(ctx)
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00A0' || c === '\uFEFF' || c === '\u2028' || c === '\u2029') {
			ctx.pos++
			continue
		}
		if (c === '/' && peek2(ctx) === '/') {
			ctx.pos += 2
			while (ctx.pos < ctx.buf.length && peek(ctx) !== '\n' && peek(ctx) !== '\r' && peek(ctx) !== '\u2028' && peek(ctx) !== '\u2029') ctx.pos++
			continue
		}
		if (c === '/' && peek2(ctx) === '*') {
			const end = ctx.buf.indexOf('*/', ctx.pos + 2)
			if (end < 0) fail(ctx, 'Unterminated comment')
			ctx.pos = end + 2
			continue
		}
		break
	}
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

const SIMPLE_ESCAPES: Record<number, string> = { 0x6e: '\n', 0x74: '\t', 0x72: '\r', 0x76: '\v', 0x30: '\0', 0x62: '\b', 0x66: '\f' }
const HEX2_RE = /^[0-9a-fA-F]{2}$/
const HEX4_RE = /^[0-9a-fA-F]{4}$/

function parseString(ctx: Ctx, quote: string): string {
	ctx.pos++ // skip opening quote
	const start = ctx.pos
	const buf = ctx.buf
	const qc = quote.charCodeAt(0)
	const checkTemplateDollar = quote === '`'

	// Fast path: scan for a plain closing quote before falling back to escapes.
	let pos = ctx.pos
	while (pos < buf.length) {
		const cc = buf.charCodeAt(pos)
		if (cc === 0x5c) break
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

	const segments: string[] = []
	let segStart = start
	ctx.pos = pos
	while (ctx.pos < buf.length) {
		const cc = buf.charCodeAt(ctx.pos)
		if (cc === 0x5c) {
			segments.push(buf.slice(segStart, ctx.pos))
			ctx.pos++
			const esc = buf.charCodeAt(ctx.pos)
			switch (esc) {
				case 0x0d:
					if (buf.charCodeAt(ctx.pos + 1) === 0x0a) ctx.pos++
					break
				case 0x0a:
				case 0x2028:
				case 0x2029:
					break
				case 0x78:
				case 0x75: {
					const size = esc === 0x78 ? 2 : 4
					const hex = buf.slice(ctx.pos + 1, ctx.pos + 1 + size)
					if (!(size === 2 ? HEX2_RE : HEX4_RE).test(hex)) fail(ctx, size === 2 ? 'Invalid hex escape' : 'Invalid unicode escape')
					segments.push(String.fromCharCode(parseInt(hex, 16)))
					ctx.pos += size
					break
				}
				default:
					segments.push(SIMPLE_ESCAPES[esc] ?? buf[ctx.pos]!)
			}
			ctx.pos++
			segStart = ctx.pos
			continue
		}
		if (cc === qc) {
			segments.push(buf.slice(segStart, ctx.pos))
			ctx.pos++
			return segments.join('')
		}
		if (checkTemplateDollar && cc === 0x24 && buf.charCodeAt(ctx.pos + 1) === 0x7b) fail(ctx, 'Template interpolation is not supported')
		ctx.pos++
	}
	fail(ctx, 'Unterminated string')
}

// Numeric separators: underscores between digits are allowed (like JS 1_000_000).
// The regex accepts them, then we strip before Number()/BigInt()/parseInt().
const HEX_BIGINT_RE = /[+-]?0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*n/y
const INT_BIGINT_RE = /[+-]?[0-9]+(?:_[0-9]+)*n/y
const HEX_RE = /[+-]?0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*/y
const NUM_RE = /[+-]?(?:[0-9]+(?:_[0-9]+)*(?:\.(?:[0-9]+(?:_[0-9]+)*)?)?|\.[0-9]+(?:_[0-9]+)*)(?:[eE][+-]?[0-9]+(?:_[0-9]+)*)?/y

function parseNumber(ctx: Ctx): number | bigint {
	HEX_BIGINT_RE.lastIndex = ctx.pos
	const hexBig = HEX_BIGINT_RE.exec(ctx.buf)
	if (hexBig) {
		ctx.pos = HEX_BIGINT_RE.lastIndex
		const literal = hexBig[0].slice(0, -1).replace(/_/g, '')
		const sign = literal[0] === '-' ? -1n : 1n
		return sign * BigInt(literal.replace(/^[+-]/, ''))
	}
	INT_BIGINT_RE.lastIndex = ctx.pos
	const intBig = INT_BIGINT_RE.exec(ctx.buf)
	if (intBig) {
		ctx.pos = INT_BIGINT_RE.lastIndex
		return BigInt(intBig[0].slice(0, -1).replace(/_/g, ''))
	}
	HEX_RE.lastIndex = ctx.pos
	const hex = HEX_RE.exec(ctx.buf)
	if (hex) {
		ctx.pos = HEX_RE.lastIndex
		const sign = hex[0][0] === '-' ? -1 : 1
		return sign * parseInt(hex[0].replace(/^[+-]/, '').replace(/_/g, ''), 16)
	}
	NUM_RE.lastIndex = ctx.pos
	const m = NUM_RE.exec(ctx.buf)
	if (!m) fail(ctx, 'Invalid number')
	ctx.pos = NUM_RE.lastIndex
	return Number(m[0].replace(/_/g, ''))
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
	return ctx.buf.slice(start, ctx.pos).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function parseObject(ctx: Ctx): AsonObject {
	ctx.pos++ // skip {
	const obj: AsonObject = {}
	while (true) {
		skipWhite(ctx)
		if (eat(ctx, '}')) break
		const key = parseKey(ctx)
		skipWhite(ctx)
		eat(ctx, ':', true)
		obj[key] = parseAny(ctx)
		skipWhite(ctx)
		if (eat(ctx, '}')) break
		if (!eat(ctx, ',')) fail(ctx, "Expected ',' or '}'")
	}
	return obj
}

function parseArray(ctx: Ctx): AsonArray {
	ctx.pos++ // skip [
	const arr: AsonArray = []
	while (true) {
		skipWhite(ctx)
		if (eat(ctx, ']')) break
		arr.push(parseAny(ctx))
		skipWhite(ctx)
		if (eat(ctx, ']')) break
		if (!eat(ctx, ',')) fail(ctx, "Expected ',' or ']'")
	}
	return arr
}

function parseKeyword<T extends AsonValue>(ctx: Ctx, word: string, value: T): T {
	eatWord(ctx, word)
	return value
}
function parseSignedWord(ctx: Ctx, sign: '+' | '-', word: 'Infinity' | 'NaN'): number {
	eatWord(ctx, sign + word)
	return word === 'NaN' ? NaN : sign === '-' ? -Infinity : Infinity
}

function parseAny(ctx: Ctx): AsonValue {
	skipWhite(ctx)
	const c = peek(ctx)
	switch (c) {
		case '{':
			return parseObject(ctx)
		case '[':
			return parseArray(ctx)
		case "'":
		case '"':
		case '`':
			return parseString(ctx, c)
		case '+':
		case '-':
			if (peek2(ctx) === 'I') return parseSignedWord(ctx, c, 'Infinity')
			if (peek2(ctx) === 'N') return parseSignedWord(ctx, c, 'NaN')
			return parseNumber(ctx)
		case 't':
			return parseKeyword(ctx, 'true', true)
		case 'f':
			return parseKeyword(ctx, 'false', false)
		case 'n':
			return parseKeyword(ctx, 'null', null)
		case 'u':
			return parseKeyword(ctx, 'undefined', undefined)
		case 'N':
			return parseKeyword(ctx, 'NaN', NaN)
		case 'I':
			return parseKeyword(ctx, 'Infinity', Infinity)
	}
	if (/[0-9.]/.test(c)) return parseNumber(ctx)
	fail(ctx, 'Unexpected token')
}

/** Parse a single ASON value. Invalid input throws a ParseError with `pos`. */
function parse(str: string): AsonValue {
	const ctx: Ctx = { buf: str, pos: 0 }
	const value = parseAny(ctx)
	skipWhite(ctx)
	if (ctx.pos < ctx.buf.length) fail(ctx, 'Unexpected content after value')
	return value
}

/** Parse every value in an ASONL string (records may also span lines). */
function parseAll(str: string): AsonValue[] {
	const ctx: Ctx = { buf: str, pos: 0 }
	const results: AsonValue[] = []
	skipWhite(ctx)
	while (ctx.pos < ctx.buf.length) {
		results.push(parseAny(ctx))
		skipWhite(ctx)
	}
	return results
}

/** One ASONL record: the value on a single line, newline-terminated. */
function stringifyLine(value: unknown): string {
	return `${ason.stringify(value, 'short')}\n`
}

/** Yields newline-delimited lines from a byte stream, and whether each
 *  was newline-terminated (only the last one may not be). */
async function* streamLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<[string, boolean]> {
	const decoder = new TextDecoder()
	let buf = ''
	for await (const chunk of stream) {
		buf += decoder.decode(chunk, { stream: true })
		const lines = buf.split('\n')
		buf = lines.pop()!
		for (const line of lines) yield [line, true]
	}
	buf += decoder.decode()
	if (buf) yield [buf, false]
}

export type ParseStreamOptions = {
	/** The stream may start mid-record (e.g. read from an offset): skip a bad first line. */
	midRecord?: boolean
	/** An unterminated last line that fails to parse is a partial write:
	 *  hand it here instead of throwing. */
	onPartial?: (fragment: string) => void
}

/** Yields parsed ASON values from a byte stream, one per newline-delimited
 *  record, as soon as each line is complete. A bad record throws. */
async function* parseStream(stream: ReadableStream<Uint8Array>, opts: ParseStreamOptions = {}): AsyncGenerator<AsonValue> {
	let first = true
	for await (const [line, terminated] of streamLines(stream)) {
		if (!line.trim()) continue
		let value: AsonValue
		try {
			value = ason.parse(line)
		} catch (e) {
			const skipFirst = first && opts.midRecord
			first = false
			if (skipFirst) continue
			if (!terminated && opts.onPartial) {
				opts.onPartial(line)
				continue
			}
			throw e
		}
		first = false
		yield value
	}
}

export const ason = { stringify, stringifyLine, parse, parseAll, parseStream }
