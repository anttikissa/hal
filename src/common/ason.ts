// ASON 0.1.0 — A Saner Object Notation
// MIT license. One TypeScript file, no dependencies.
//
// A drop-in replacement for JSON and JSONL that people can read and write.
// Use it wherever readability and convenience matter: config files (comments
// survive a round trip), wire messages, and logs (ASONL, one record a line).
//
//   import { parse, stringify } from './ason'
//
//   const settings = parse(`{
//   	name: 'demo',        // comments
//   	port: 8_080,         // JS numbers
//   	tags: ['a', 'b',],   // trailing commas
//   }`)
//   stringify(settings)    // { name: 'demo', port: 8080, tags: ['a', 'b'] }
//
//   stringify(value)                 // smart: one line if it fits 80 columns, else expanded
//   stringify(value, 'short')        // always one line: an ASONL record or a wire message
//   stringify(value, 'long')         // every object and array expanded
//   stringify(value, { indent: 2 })  // indent: '\t' (default), '  ' or a number of spaces
//   config.indent = '  '             // process-wide defaults; per-call options win
//   config.tabWidth = 4              // columns a tab takes when fitting 80 columns
//
// Nearly (*) every JS literal is valid ASON, and ASON pastes into a JS
// console: strings in '', "" or `` (backticks span lines), unquoted keys,
// trailing commas, // and /* */ comments, and your regular JS numbers like
// 1_000, 0xFF, 42n (BigInt), NaN and Infinity. And undefined.
//
// Already know JSON5 or JSONC? Then you know ASON. It reads JSON, JSONC,
// JWCC (HuJSON) and JSON5 files as they are, so point it at any of them.
// Formats that drop quotes or commas (Hjson, RJSON, CSON, YAML) are another
// idea; ASON stays JavaScript.
//
// Errors tell you where, and show you. JSON.parse says "Expected '}'" or
// "at position 4231"; ASON says:
//
//   parse(`{
//   	name: 'demo'
//   	port: 8080,
//   }`)
//   // Expected ',' or '}' at 3:2:
//   //     	port: 8080,
//   //     	^
//
// The error also carries .pos, the offset into the text.
//
// Comments can be kept if you need them: parse(text, { comments: true }).
// Not all of them: for simplicity, ASON keeps the common case, a comment
// above the root value, a key or an array item, and stringify writes it
// back. Trailing comments are dropped.
//
//   // this is kept
//   {
//   	/* this
//   	   too */
//   	abc: 123,
//   	// and this
//   	xyz: 234 /* but this is gone */,
//   }
//   // and so is this
//
// Kept comments stay with their key when you change the value; a key you
// delete takes its comment along. Array comments stay with positions, not
// items. 'short' writes no comments.
//
// Stringify is lenient: it never throws, so it is safe to log anything.
//
//   JS value            ASON                         JSON
//   undefined           undefined                    (dropped)
//   NaN, -Infinity      NaN, -Infinity               null
//   42n                 42n                          throws
//   -0                  -0                           0
//   new Date(0)         '1970-01-01T00:00:00.000Z'   "1970-01-01T00:00:00.000Z"
//   function f() {}     '[Function: f]'              (dropped)
//   Symbol('x')         'Symbol(x)'                  (dropped)
//   new Map([[1, 2]])   {}                           {}
//   new Error('no')     {}                           {}
//
// Like JSON, it calls toJSON(key) first and writes other objects as their
// own enumerable keys.
//
// ASONL is ASON lines, as JSONL is JSON lines: one stringify(value, 'short')
// per line, each ending in \n (\r\n is read too). Blank lines and lines
// starting with // are skipped; comments are never kept.
//
//   parseAll(text)       // a whole file; a torn last line throws
//   for await (const record of parseStream(file.stream())) { … }
//
// parseStream yields records as bytes arrive. It may start mid-record, e.g.
// when tailing a log from a byte offset: it drops a malformed first line up
// to its \n, then is strict.
//
// Future experiments, not decided:
// - stringify(value, { strict: true }): throw, naming the path (.meta.time),
//   on a value parse cannot give back. (parse is strict already.)
// - Write Date, Map and Set as new Date('2026-10-06T…'), new Map([[k, v]])
//   and new Set([…]), and parse exactly those forms (no code runs), so they
//   round-trip and still paste into JS.
//
// (*) Exceptions and fine print:
// - Not supported: regex literals and array holes ([1,,2]).
// - Keys: unquoted keys are JS identifiers (café, $x) or integers (0: 'x');
//   keys like 1.5 or 0x10 must be quoted. stringify quotes every key that
//   is not an ASCII identifier.
// - What strict-mode JS rejects is an error: 017, "\101".
// - Escapes: \x41, \u0041, \u{1F600}. stringify escapes invisible
//   characters, so output is plain printable text.
// - Backtick strings read \r\n as \n, as JS does.
// - Whitespace is whatever JS counts as whitespace.
// - A __proto__ key is an ordinary key, as with JSON.parse.
//
// Changelog
// 0.1.0  Initial release: reasonable JS literals, comment round trip.
//        55 tests, 423 lines of code.

/** Symbol key for attaching comments to AsonObject/AsonArray. */
export const COMMENTS = Symbol('comments')
// The comment above the root value, kept by parse({ comments: true }) and written by stringify.
const LEAD = Symbol('lead comment')

/** Any value representable in ASON. */
export type AsonValue = string | number | bigint | boolean | null | undefined | AsonArray | AsonObject

/** Array with optional comment metadata per element. */
export type AsonArray = AsonValue[] & { [COMMENTS]?: (string | undefined)[] }
/** Object with optional comment metadata per key. */
export type AsonObject = {
	[key: string]: AsonValue
	[COMMENTS]?: Record<string, string>
}

// --- Stringify ---

// Characters a reader can't see or a UTF-8 file can't hold: control characters,
// U+2028/U+2029 and lone surrogates. \r is escaped even in backticks: JS reads a
// raw \r\n in a template as \n.
const UNSAFE_RE = /[\0-\x08\x0b-\x1f\x7f\u2028\u2029]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
const SHORT_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }
function escapeUnsafe(c: string): string {
	const code = c.charCodeAt(0)
	return SHORT_ESCAPES[c] ?? (code < 0x100 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16)}`)
}

function quoteString(s: string, multiline = false): string {
	if (multiline && s.includes('\n')) {
		const escaped = s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(UNSAFE_RE, escapeUnsafe)
		return `\`${escaped}\``
	}
	const escaped = s.replace(/\\/g, '\\\\').replace(/[\n\r\t]/g, escapeUnsafe).replace(UNSAFE_RE, escapeUnsafe)
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

function commentPrefix(comment: string | undefined, pad: string): string {
	return comment ? `${indentComment(comment, pad)}\n` : ''
}

// In long mode, skip the unused inline candidate: computing both forms at every level is exponential.
function renderCollection(open: string, close: string, inline: string, col: number, depth: number, maxWidth: number, unit: string, hasComments: boolean, buildLines: (pad: string, childDepth: number) => string[]): string {
	if (maxWidth === Infinity) return inline // short strings already escape newlines
	if (maxWidth > 0 && !hasComments && col + inline.length <= maxWidth && !inline.includes('\n')) return inline
	const childDepth = depth + 1
	return `${open}\n${buildLines(unit.repeat(childDepth), childDepth).join('\n')}\n${unit.repeat(depth)}${close}`
}

// Values ASON has no literal for: toJSON(key) runs first, as in JSON (a Date
// becomes its ISO string); functions and symbols become descriptive strings,
// as Node's inspect names them, so output always parses; other objects (Map,
// Set, Error, class instances) are written as their own enumerable keys.
function toJsonValue(value: unknown, key: string): unknown {
	const toJSON = (value as { toJSON?: unknown } | null | undefined)?.toJSON
	const v = typeof toJSON === 'function' ? toJSON.call(value, key) : value
	if (typeof v === 'symbol') return v.toString()
	if (typeof v !== 'function') return v
	if (/^class\b/.test(Function.prototype.toString.call(v))) return `[class ${v.name || '(anonymous)'}]`
	return `[Function: ${v.name || '(anonymous)'}]`
}

// cols: the indent unit's width in columns, a tab counting as config.tabWidth.
function stringifyValue(obj: unknown, col: number, depth: number, maxWidth: number, unit: string, cols: number): string {
	if (obj === null) return 'null'
	if (obj === undefined) return 'undefined'
	if (typeof obj === 'boolean') return obj ? 'true' : 'false'
	if (typeof obj === 'number') {
		if (Number.isNaN(obj)) return 'NaN'
		if (obj === Infinity) return 'Infinity'
		if (obj === -Infinity) return '-Infinity'
		if (Object.is(obj, -0)) return '-0'
		return String(obj)
	}
	if (typeof obj === 'bigint') return `${obj}n`
	if (typeof obj === 'string') return quoteString(obj, maxWidth < Infinity)

	if (Array.isArray(obj)) {
		if (obj.length === 0) return '[]'
		const comments = maxWidth < Infinity ? (obj as AsonArray)[COMMENTS] : undefined
		const items = obj.map((v, i) => toJsonValue(v, String(i)))
		const inline = maxWidth === 0 ? '' : `[${items.map((v) => stringifyValue(v, 0, depth, maxWidth, unit, cols)).join(', ')}]`
		return renderCollection('[', ']', inline, col, depth, maxWidth, unit, !!comments, (pad, childDepth) =>
			items.map((v, i) => `${commentPrefix(comments?.[i], pad)}${pad}${stringifyValue(v, childDepth * cols, childDepth, maxWidth, unit, cols)}${i < items.length - 1 ? ',' : ''}`),
		)
	}

	if (typeof obj === 'object') {
		const rec = obj as AsonObject
		const entries = Object.keys(rec).map((k): [string, unknown] => [k, toJsonValue(rec[k], k)])
		if (entries.length === 0) return '{}'
		const comments = maxWidth < Infinity ? rec[COMMENTS] : undefined
		const inline = maxWidth === 0 ? '' : `{ ${entries.map(([k, v]) => `${quoteKey(k)}: ${stringifyValue(v, 0, depth, maxWidth, unit, cols)}`).join(', ')} }`
		return renderCollection('{', '}', inline, col, depth, maxWidth, unit, !!comments, (pad, childDepth) =>
			entries.map(([k, v], i) => `${commentPrefix(comments?.[k], pad)}${pad}${quoteKey(k)}: ${stringifyValue(v, childDepth * cols + `${quoteKey(k)}: `.length, childDepth, maxWidth, unit, cols)}${i < entries.length - 1 ? ',' : ''}`),
		)
	}

	throw new Error(`TODO: unsupported type ${typeof obj}`)
}

export type StringifyMode = 'short' | 'smart' | 'long'
/** indent: a string such as '\t' or '  ', or a number of spaces. */
export type StringifyOptions = { mode?: StringifyMode; indent?: string | number; tabWidth?: number }

/** Process-wide defaults for stringify; per-call options override them. */
export const config = { indent: '\t' as string | number, tabWidth: 4 }

/** Convert a value to an ASON string. Mode: 'smart' (default, 80-col wrap), 'short' (single line), 'long' (always expanded). */
export function stringify(obj: unknown, opts: StringifyMode | StringifyOptions = 'smart'): string {
	const { mode = 'smart', indent = config.indent, tabWidth = config.tabWidth } = typeof opts === 'string' ? { mode: opts } : opts
	const maxWidth = mode === 'short' ? Infinity : mode === 'long' ? 0 : 80
	const unit = typeof indent === 'number' ? ' '.repeat(indent) : indent
	const lead = mode === 'short' ? undefined : (obj as { [LEAD]?: string } | null | undefined)?.[LEAD]
	return commentPrefix(lead, '') + stringifyValue(toJsonValue(obj, ''), 0, 0, maxWidth, unit, unit.length + (tabWidth - 1) * (unit.split('\t').length - 1))
}

// --- Parse ---

type Ctx = { buf: string; pos: number; comments?: boolean }
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

// JS whitespace and line terminators: \s matches exactly those.
function isSpace(c: string): boolean {
	return c === ' ' || c === '\t' || c === '\n' || c === '\r' || (c > '~' && /\s/.test(c)) || c === '\f' || c === '\v'
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
		if (isSpace(c)) {
			ctx.pos++
			continue
		}
		if (c === '/' && peek2(ctx) === '/') {
			const start = ctx.pos
			ctx.pos += 2
			while (ctx.pos < ctx.buf.length && peek(ctx) !== '\n' && peek(ctx) !== '\r' && peek(ctx) !== '\u2028' && peek(ctx) !== '\u2029') ctx.pos++
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
			const end = ctx.buf.indexOf('*/', start + 2)
			if (end < 0) fail(ctx, 'Unterminated comment')
			ctx.pos = end + 2
			if (ctx.comments) {
				if (newlines >= 2) collected += '\n'
				// Continuation lines lose the comment's own indentation; stringify re-indents them.
				const indent = ctx.buf.slice(ctx.buf.lastIndexOf('\n', start) + 1, start)
				const text = ctx.buf.slice(start, ctx.pos)
				collected += /^[ \t]+$/.test(indent) ? text.replaceAll(`\n${indent}`, '\n') : text
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

const SIMPLE_ESCAPES: Record<number, string> = { 0x6e: '\n', 0x74: '\t', 0x72: '\r', 0x76: '\v', 0x30: '\0', 0x62: '\b', 0x66: '\f' }
const HEX2_RE = /^[0-9a-fA-F]{2}$/
const HEX4_RE = /^[0-9a-fA-F]{4}$/

function parseString(ctx: Ctx, quote: string): string {
	ctx.pos++ // skip opening quote
	const buf = ctx.buf
	const template = quote === '`'
	const segments: string[] = []
	let end = buf.indexOf(quote, ctx.pos)
	while (ctx.pos < buf.length) {
		// Cache the quote across escapes, and bound searches to this string.
		// Re-scanning for a quote after every newline escape is quadratic.
		if (end >= 0 && end < ctx.pos) end = buf.indexOf(quote, ctx.pos)
		const remaining = buf.slice(ctx.pos, end < 0 ? buf.length : end)
		const slash = remaining.indexOf('\\')
		const part = slash < 0 ? remaining : remaining.slice(0, slash)
		if (template) {
			const dollar = part.indexOf('${')
			if (dollar >= 0) {
				ctx.pos += dollar
				fail(ctx, 'Template interpolation is not supported')
			}
		}
		const next = ctx.pos + part.length
		ctx.pos = next
		if (next === buf.length) break
		const text = template && part.includes('\r') ? part.replace(/\r\n?/g, '\n') : part
		if (next === end) {
			ctx.pos++
			if (!segments.length) return text
			segments.push(text)
			return segments.join('')
		}
		segments.push(text)
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
			case 0x75:
				if (buf[ctx.pos + 1] === '{') {
					const close = buf.indexOf('}', ctx.pos)
					const hex = close < 0 ? '' : buf.slice(ctx.pos + 2, close)
					if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) fail(ctx, 'Invalid unicode escape')
					segments.push(String.fromCodePoint(parseInt(hex, 16)))
					ctx.pos = close
					break
				}
			// falls through
			case 0x78: {
				const size = esc === 0x78 ? 2 : 4
				const hex = buf.slice(ctx.pos + 1, ctx.pos + 1 + size)
				if (!(size === 2 ? HEX2_RE : HEX4_RE).test(hex)) fail(ctx, size === 2 ? 'Invalid hex escape' : 'Invalid unicode escape')
				segments.push(String.fromCharCode(parseInt(hex, 16)))
				ctx.pos += size
				break
			}
			default:
				// Strict JS rejects legacy octal escapes (\1, \01): sloppy JS reads "\101" as "A".
				if ((esc >= 0x31 && esc <= 0x39) || (esc === 0x30 && /[0-9]/.test(buf[ctx.pos + 1] ?? ''))) fail(ctx, 'Octal escapes are not allowed')
				segments.push(SIMPLE_ESCAPES[esc] ?? buf[ctx.pos]!)
		}
		ctx.pos++
	}
	fail(ctx, 'Unterminated string')
}

// Numeric separators: underscores between digits are allowed (like JS 1_000_000).
// The regex accepts them, then we strip before Number()/BigInt()/parseInt().
const RADIX = '0(?:[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*|[oO][0-7]+(?:_[0-7]+)*|[bB][01]+(?:_[01]+)*)'
const HEX_BIGINT_RE = new RegExp(`[+-]?${RADIX}n`, 'y')
const INT_BIGINT_RE = /[+-]?[0-9]+(?:_[0-9]+)*n/y
const HEX_RE = new RegExp(`[+-]?${RADIX}`, 'y')
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
	// Strict JS rejects 017 and 08; sloppy JS reads 017 as octal 15.
	if (/^[+-]?0[0-9_]/.test(ctx.buf.slice(ctx.pos, ctx.pos + 3))) fail(ctx, 'Leading zeros are not allowed')
	if (intBig) {
		ctx.pos = INT_BIGINT_RE.lastIndex
		return BigInt(intBig[0].slice(0, -1).replace(/_/g, ''))
	}
	HEX_RE.lastIndex = ctx.pos
	const hex = HEX_RE.exec(ctx.buf)
	if (hex) {
		ctx.pos = HEX_RE.lastIndex
		const sign = hex[0][0] === '-' ? -1 : 1
		return sign * Number(hex[0].replace(/^[+-]/, '').replace(/_/g, ''))
	}
	NUM_RE.lastIndex = ctx.pos
	const m = NUM_RE.exec(ctx.buf)
	if (!m) fail(ctx, 'Invalid number')
	ctx.pos = NUM_RE.lastIndex
	return Number(m[0].replace(/_/g, ''))
}

// Unquoted keys are what JS accepts: identifiers (Unicode, \uXXXX escapes) or
// integers. The escaped form must still decode to an identifier.
const KEY_RE = /(?:[\p{ID_Start}$_]|\\u[0-9a-fA-F]{4})(?:[\p{ID_Continue}$\u200C\u200D]|\\u[0-9a-fA-F]{4})*|0|[1-9][0-9]*/uy
const IDENT_FULL_RE = /^(?:[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*|0|[1-9][0-9]*)$/u

function parseKey(ctx: Ctx): string {
	skipWhite(ctx)
	const c = peek(ctx)
	if (c === "'" || c === '"') return parseString(ctx, c)
	KEY_RE.lastIndex = ctx.pos
	const m = KEY_RE.exec(ctx.buf)
	const key = m?.[0].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
	if (!key || !IDENT_FULL_RE.test(key)) fail(ctx, 'Expected object key (an identifier, an integer or a quoted string)')
	ctx.pos = KEY_RE.lastIndex
	return key
}

// obj['__proto__'] = v would replace the prototype; define an own key, as JSON.parse does.
function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
	if (key === '__proto__') Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
	else obj[key] = value
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
			setOwn(commentMap, key, comment)
		}
		skipWhite(ctx)
		eat(ctx, ':', true)
		setOwn(obj, key, parseAny(ctx))
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

/** Parse a single ASON value. Pass `{ comments: true }` to preserve comments as `[COMMENTS]` metadata. */
export function parse(str: string, opts?: { comments?: boolean }): AsonValue {
	const ctx: Ctx = { buf: str, pos: 0, comments: opts?.comments }
	const lead = skipWhite(ctx)
	const value = parseAny(ctx)
	skipWhite(ctx)
	if (ctx.pos < ctx.buf.length) fail(ctx, 'Unexpected content after value')
	if (lead && value && typeof value === 'object') (value as { [LEAD]?: string })[LEAD] = lead
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
 *  e.g. "a\nb\nc" → ["a","b","c"] → yield "a", buf="c" */
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
		if (!line.trim() || line.trimStart().startsWith('//')) continue
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

export const ason = { stringify, parse, parseAll, parseStream, COMMENTS, config }
export default ason
