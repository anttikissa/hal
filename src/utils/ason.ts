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

function quoteString(s: string): string {
	const escaped = s
		.replace(/\\/g, '\\\\')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t')
	const hasSingle = s.includes("'")
	const hasDouble = s.includes('"')
	// Prefer single quotes; use double if string contains ' but not "
	if (hasSingle && !hasDouble) return `"${escaped}"`
	return `'${escaped.replace(/'/g, "\\'")}'`
}

const IDENT_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/

function quoteKey(key: string): string {
	return IDENT_RE.test(key) ? key : quoteString(key)
}

// col = column position where this value starts (for inline width check)
// depth = nesting depth (for indentation of multi-line output)
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

		// Try inline first
		const items = obj.map(v => stringifyValue(v, 0, depth, maxWidth))
		const inline = `[${items.join(', ')}]`
		if (col + inline.length <= maxWidth && !inline.includes('\n')) return inline

		// Multi-line
		const childDepth = depth + 1
		const pad = '  '.repeat(childDepth)
		const lines = obj.map((v, i) => `${pad}${stringifyValue(v, pad.length, childDepth, maxWidth)},`)
		return `[\n${lines.join('\n')}\n${'  '.repeat(depth)}]`
	}

	if (typeof obj === 'object') {
		const keys = Object.keys(obj)
		if (keys.length === 0) return '{}'

		// Try inline first
		const pairs = keys.map(k => `${quoteKey(k)}: ${stringifyValue(obj[k], 0, depth, maxWidth)}`)
		const inline = `{ ${pairs.join(', ')} }`
		if (col + inline.length <= maxWidth && !inline.includes('\n')) return inline

		// Multi-line
		const childDepth = depth + 1
		const pad = '  '.repeat(childDepth)
		const lines = keys.map(k => {
			const prefix = `${pad}${quoteKey(k)}: `
			const val = stringifyValue(obj[k], prefix.length, childDepth, maxWidth)
			return `${prefix}${val},`
		})
		return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`
	}

	throw new Error(`TODO: unsupported type ${typeof obj}`)
}

export function stringify(obj: any): string {
	return stringifyValue(obj, 0, 0, 80)
}

class ParseError extends Error {
	pos: number
	constructor(msg: string, pos: number) {
		super(msg)
		this.pos = pos
	}
}

class Parser {
	private src: string
	private pos: number = 0
	private lines: string[]

	constructor(src: string) {
		this.src = src
		this.lines = src.split('\n')
	}

	private error(msg: string): never {
		// Find line/col from pos
		let line = 1, col = 1
		for (let i = 0; i < this.pos && i < this.src.length; i++) {
			if (this.src[i] === '\n') { line++; col = 1 } else { col++ }
		}
		const lineText = this.lines[line - 1] ?? ''
		throw new ParseError(`${msg} at ${line}:${col}:\n    ${lineText}\n    ${' '.repeat(col - 1)}^`, this.pos)
	}

	skipWhitespace(): void {
		while (this.pos < this.src.length) {
			const ch = this.src[this.pos]
			// Whitespace
			if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
				this.pos++
				continue
			}
			// Line comment
			if (ch === '/' && this.src[this.pos + 1] === '/') {
				this.pos += 2
				while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++
				continue
			}
			// Block comment
			if (ch === '/' && this.src[this.pos + 1] === '*') {
				this.pos += 2
				while (this.pos < this.src.length) {
					if (this.src[this.pos] === '*' && this.src[this.pos + 1] === '/') {
						this.pos += 2
						break
					}
					this.pos++
				}
				continue
			}
			break
		}
	}

	getPosition(): number {
		return this.pos
	}

	private peek(): string {
		this.skipWhitespace()
		return this.src[this.pos] ?? ''
	}

	private parseString(quote: string): string {
		this.pos++ // skip opening quote
		let result = ''
		while (this.pos < this.src.length) {
			const ch = this.src[this.pos]
			if (ch === '\\') {
				this.pos++
				const esc = this.src[this.pos]
				if (esc === 'n') result += '\n'
				else if (esc === 't') result += '\t'
				else if (esc === 'r') result += '\r'
				else if (esc === '\\') result += '\\'
				else if (esc === "'") result += "'"
				else if (esc === '"') result += '"'
				else result += esc
				this.pos++
				continue
			}
			if (ch === quote) {
				this.pos++ // skip closing quote
				return result
			}
			result += ch
			this.pos++
		}
		this.error('Unterminated string')
	}

	private parseNumber(): number {
		const start = this.pos
		if (this.src[this.pos] === '-') this.pos++
		while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos])) this.pos++
		// Scientific notation
		if (this.pos < this.src.length && (this.src[this.pos] === 'e' || this.src[this.pos] === 'E')) {
			this.pos++
			if (this.src[this.pos] === '+' || this.src[this.pos] === '-') this.pos++
			while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos])) this.pos++
		}
		const num = Number(this.src.slice(start, this.pos))
		if (isNaN(num)) this.error('Invalid number')
		return num
	}

	private parseKey(): string {
		const ch = this.peek()
		// Quoted key
		if (ch === "'" || ch === '"') return this.parseString(ch)
		// Unquoted identifier key
		const start = this.pos
		while (this.pos < this.src.length && /[a-zA-Z0-9_$]/.test(this.src[this.pos])) this.pos++
		if (this.pos === start) this.error('Expected object key')
		return this.src.slice(start, this.pos)
	}

	private parseObject(): Record<string, any> {
		this.pos++ // skip {
		const obj: Record<string, any> = {}
		while (true) {
			const ch = this.peek()
			if (ch === '}') { this.pos++; return obj }
			const key = this.parseKey()
			if (this.peek() !== ':') this.error("Expected ':'")
			this.pos++ // skip :
			obj[key] = this.parseValue()
			const next = this.peek()
			if (next === ',') this.pos++ // skip comma
		}
	}

	private parseArray(): any[] {
		this.pos++ // skip [
		const arr: any[] = []
		while (true) {
			const ch = this.peek()
			if (ch === ']') { this.pos++; return arr }
			arr.push(this.parseValue())
			const next = this.peek()
			if (next === ',') this.pos++ // skip comma
		}
	}

	private parseKeyword(): any {
		const remaining = this.src.slice(this.pos)
		const keywords: [string, any][] = [
			['null', null],
			['undefined', undefined],
			['true', true],
			['false', false],
			['NaN', NaN],
			['Infinity', Infinity],
			['-Infinity', -Infinity],
		]
		for (const [kw, val] of keywords) {
			if (remaining.startsWith(kw) && !/[a-zA-Z0-9_$]/.test(remaining[kw.length] ?? '')) {
				this.pos += kw.length
				return val
			}
		}
		this.error('Unexpected token')
	}

	parseValue(): any {
		const ch = this.peek()
		if (ch === '{') return this.parseObject()
		if (ch === '[') return this.parseArray()
		if (ch === "'" || ch === '"') return this.parseString(ch)
		if (ch === '-') {
			// Could be -Infinity or a number
			if (this.src.slice(this.pos).startsWith('-Infinity')) {
				const after = this.src[this.pos + 9] ?? ''
				if (!/[a-zA-Z0-9_$]/.test(after)) {
					this.pos += 9
					return -Infinity
				}
			}
			return this.parseNumber()
		}
		if (ch >= '0' && ch <= '9') return this.parseNumber()
		return this.parseKeyword()
	}

	parseRoot(): any {
		const value = this.parseValue()
		this.skipWhitespace()
		if (this.pos < this.src.length) this.error('Unexpected content after value')
		return value
	}

	/** Returns true if there's more non-whitespace/comment content to parse */
	hasMore(): boolean {
		this.skipWhitespace()
		return this.pos < this.src.length
	}

	parseMultiple(): any[] {
		const results: any[] = []
		while (this.hasMore()) results.push(this.parseValue())
		return results
	}
}

export function parse(str: string): any {
	return new Parser(str).parseRoot()
}

export function parseAll(str: string): any[] {
	return new Parser(str).parseMultiple()
}

type ParseAttempt =
	| { kind: 'empty' }
	| { kind: 'ok'; value: any; end: number }
	| { kind: 'parse_error'; error: ParseError }
	| { kind: 'fatal'; error: unknown }

type ReaderReadResult = { done: true; value?: Uint8Array } | { done: false; value: Uint8Array }
const RECOVER_HEAD_GRACE_MS = 50

// Stream records must be top-level objects/arrays. Primitives are rejected.
function isStreamableValue(val: any): boolean {
	if (val === null) return false
	return typeof val === 'object'
}

function findRecoveryStart(input: string, from = 0): number {
	for (let i = Math.max(0, from); i < input.length; i++) {
		const ch = input[i]
		if (ch !== '}' && ch !== ']') continue
		let j = i + 1
		while (j < input.length && /\s/.test(input[j])) j++
		if (j < input.length && (input[j] === '{' || input[j] === '[')) return j
	}
	return -1
}

function findNextNonWhitespace(input: string, from: number): number {
	let i = Math.max(0, from)
	while (i < input.length && /\s/.test(input[i])) i++
	return i < input.length ? i : -1
}

function hasDangerousContinuation(input: string, from: number): boolean {
	const idx = findNextNonWhitespace(input, from)
	return idx >= 0 && (input[idx] === '}' || input[idx] === ']' || input[idx] === ',')
}

// Finds the end (exclusive) of a balanced top-level object/array starting at
// `start` (`{` or `[`). Returns:
// - >= 0: matching end index
// - -1: incomplete (need more bytes)
// - -2: structurally invalid (mismatched closer)
function findBalancedContainerEnd(input: string, start: number): number {
	const open = input[start]
	if (open !== '{' && open !== '[') return -2
	const stack: string[] = [open]
	let quote: "'" | '"' | null = null
	let escaped = false
	let lineComment = false
	let blockComment = false

	for (let i = start + 1; i < input.length; i++) {
		const ch = input[i]

		if (lineComment) {
			if (ch === '\n') lineComment = false
			continue
		}
		if (blockComment) {
			if (ch === '*' && input[i + 1] === '/') { blockComment = false; i++ }
			continue
		}

		if (quote) {
			if (escaped) { escaped = false; continue }
			if (ch === '\\') { escaped = true; continue }
			if (ch === quote) quote = null
			continue
		}

		if (ch === '/' && input[i + 1] === '/') { lineComment = true; i++; continue }
		if (ch === '/' && input[i + 1] === '*') { blockComment = true; i++; continue }
		if (ch === "'" || ch === '"') { quote = ch; continue }
		if (ch === '{' || ch === '[') { stack.push(ch); continue }
		if (ch !== '}' && ch !== ']') continue

		const last = stack.pop()
		if (!last) return -2
		if ((last === '{' && ch !== '}') || (last === '[' && ch !== ']')) return -2
		if (stack.length === 0) return i + 1
	}

	return -1
}

function parseBufferValue(buf: string): ParseAttempt {
	const parser = new Parser(buf)
	parser.skipWhitespace()
	if (parser.getPosition() >= buf.length) return { kind: 'empty' }
	try {
		return { kind: 'ok', value: parser.parseValue(), end: parser.getPosition() }
	} catch (e) {
		if (e instanceof ParseError) return { kind: 'parse_error', error: e }
		return { kind: 'fatal', error: e }
	}
}

function makeReadPump(reader: { read: () => Promise<ReaderReadResult> }) {
	let pending: Promise<ReaderReadResult> | null = null
	const read = async () => {
		if (!pending) pending = reader.read()
		const result = await pending
		pending = null
		return result
	}
	const readOrTimeout = async (ms: number): Promise<ReaderReadResult | null> => {
		if (!pending) pending = reader.read()
		const timeoutToken = Symbol('timeout')
		const raced = await Promise.race([
			pending,
			new Promise<symbol>((resolve) => setTimeout(() => resolve(timeoutToken), ms)),
		])
		if (raced === timeoutToken) return null
		const result = raced as ReaderReadResult
		pending = null
		return result
	}
	return { read, readOrTimeout }
}

type ReadPump = ReturnType<typeof makeReadPump>
type StreamFail = (e: unknown, phase: 'mid-stream' | 'flush') => never

async function* parseStreamStrictPath(
	pump: ReadPump,
	state: { buf: string },
	appendChunk: (value: Uint8Array) => void,
	fail: StreamFail,
): AsyncGenerator<any> {
	// Strict path (`recover: false`):
	// parse from buffer start only, never resync/skip junk, throw on clear errors.
	// Strict mode: parse sequentially from buffer start and fail fast on
	// malformed mid-buffer data. Only "error at buffer end" waits for more bytes.
	// Example mid-stream state after a read:
	//   buf = "{ a: 1 }\n{ b: 2"
	// We yield { a: 1 }, then stop and wait because "{ b: 2" is incomplete.
	while (true) {
		const next = await pump.read()
		if (next.done) break
		appendChunk(next.value)
		while (state.buf.length > 0) {
			const parsed = parseBufferValue(state.buf)
			if (parsed.kind === 'empty') { state.buf = ''; break }
			if (parsed.kind === 'fatal') throw parsed.error
			if (parsed.kind === 'parse_error') {
				// Parse errors at the current buffer end are treated as incomplete
				// chunks (for example "{ foo: 123"), so we wait for more bytes.
				if (parsed.error.pos < state.buf.length - 1) fail(parsed.error, 'mid-stream')
				break
			}
			if (!isStreamableValue(parsed.value)) {
				throw new Error('ASON parseStream only supports objects/arrays by default')
			}
			// Parsed one full top-level record from buffer start.
			// Remove consumed bytes so next parse starts at the next record.
			state.buf = state.buf.slice(parsed.end)
			yield parsed.value
		}
	}

	state.buf = state.buf.trim()
	// Flush example at EOF:
	//   buf might still be "{ b: 2 }" (yield it) or "{ b: 2" (throw flush error).
	while (state.buf.length > 0) {
		const parsed = parseBufferValue(state.buf)
		if (parsed.kind === 'empty') break
		if (parsed.kind === 'fatal') fail(parsed.error, 'flush')
		if (parsed.kind === 'parse_error') fail(parsed.error, 'flush')
		if (!isStreamableValue(parsed.value)) {
			throw new Error('ASON parseStream only supports objects/arrays by default')
		}
		state.buf = state.buf.slice(parsed.end)
		yield parsed.value
	}
}

async function* parseStreamRecoveryPath(
	pump: ReadPump,
	state: { buf: string },
	appendChunk: (value: Uint8Array) => void,
): AsyncGenerator<any> {
	// Recovery path (`recover: true`):
	// frame one balanced top-level object/array at a time, parse it strictly,
	// and on corruption/misalignment resync to next boundary.
	// For the first ambiguous candidate without delimiter/newline, wait up to
	// RECOVER_HEAD_GRACE_MS (50ms) before yielding to avoid partial fragments.
	let streamDone = false

	const recoverStep = async function* (flush: boolean): AsyncGenerator<any> {
		while (state.buf.length > 0) {
			const start = findNextNonWhitespace(state.buf, 0)
			if (start < 0) { state.buf = ''; break }
			const head = state.buf[start]

			if (head !== '{' && head !== '[') {
				const boundary = findRecoveryStart(state.buf, start)
				if (boundary >= 0) { state.buf = state.buf.slice(boundary); continue }
				if (flush) { state.buf = ''; break }
				break
			}

			const end = findBalancedContainerEnd(state.buf, start)
			if (end === -1) {
				if (flush) { state.buf = ''; break }
				break
			}
			if (end === -2) {
				const boundary = findRecoveryStart(state.buf, start + 1)
				if (boundary >= 0) { state.buf = state.buf.slice(boundary); continue }
				state.buf = state.buf.slice(Math.max(1, start + 1))
				continue
			}

			const candidate = state.buf.slice(start, end)
			let value: any
			try {
				value = parse(candidate)
			} catch (e) {
				const boundary = findRecoveryStart(state.buf, end)
				if (boundary >= 0) { state.buf = state.buf.slice(boundary); continue }
				if (flush) { state.buf = ''; break }
				state.buf = state.buf.slice(end)
				continue
			}
			if (!isStreamableValue(value) || hasDangerousContinuation(state.buf, end)) {
				const boundary = findRecoveryStart(state.buf, end)
				if (boundary >= 0) { state.buf = state.buf.slice(boundary); continue }
				if (flush) { state.buf = ''; break }
				break
			}

			if (!flush && findNextNonWhitespace(state.buf, end) < 0 && !/[\r\n]/.test(state.buf.slice(end))) {
				const maybeMore = await pump.readOrTimeout(RECOVER_HEAD_GRACE_MS)
				if (maybeMore) {
					if (maybeMore.done) {
						streamDone = true
					} else {
						appendChunk(maybeMore.value)
						continue
					}
				}
			}

			state.buf = state.buf.slice(end)
			yield value
		}
	}

	while (!streamDone) {
		const next = await pump.read()
		if (next.done) { streamDone = true; break }
		appendChunk(next.value)
		yield* recoverStep(false)
	}

	state.buf = state.buf.trim()
	yield* recoverStep(true)
}

export async function* parseStream(
	stream: ReadableStream<Uint8Array>,
	options: { recover?: boolean } = {},
): AsyncGenerator<any> {
	const recover = !!options.recover
	const decoder = new TextDecoder()
	const pump = makeReadPump(stream.getReader())
	// Bytes already read from the stream but not yet consumed by parser.
	// EOF means no future bytes from the stream, but buf may still contain data.
	const state = { buf: '' }

	const fail = (e: unknown, phase: 'mid-stream' | 'flush'): never => {
		const wrapped = new Error(`ASON parseStream ${phase} error: ${e instanceof Error ? e.message : String(e)}`)
		;(wrapped as any).cause = e
		throw wrapped
	}

	const appendChunk = (value: Uint8Array) => { state.buf += decoder.decode(value, { stream: true }) }

	if (!recover) {
		yield* parseStreamStrictPath(pump, state, appendChunk, fail)
		return
	}

	yield* parseStreamRecoveryPath(pump, state, appendChunk)
}

export default { stringify, parse, parseAll, parseStream }
export type { ParseError }
