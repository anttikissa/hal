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
		const items = obj.map((v) => stringifyValue(v, 0, depth, maxWidth))
		const inline = `[${items.join(', ')}]`
		if (col + inline.length <= maxWidth && !inline.includes('\n')) return inline

		// Multi-line
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

		// Try inline first
		const pairs = keys.map(
			(k) => `${quoteKey(k)}: ${stringifyValue(obj[k], 0, depth, maxWidth)}`,
		)
		const inline = `{ ${pairs.join(', ')} }`
		if (col + inline.length <= maxWidth && !inline.includes('\n')) return inline

		// Multi-line
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
		let line = 1,
			col = 1
		for (let i = 0; i < this.pos && i < this.src.length; i++) {
			if (this.src[i] === '\n') {
				line++
				col = 1
			} else {
				col++
			}
		}
		const lineText = this.lines[line - 1] ?? ''
		throw new ParseError(
			`${msg} at ${line}:${col}:\n    ${lineText}\n    ${' '.repeat(col - 1)}^`,
			this.pos,
		)
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
		if (
			this.pos < this.src.length &&
			(this.src[this.pos] === 'e' || this.src[this.pos] === 'E')
		) {
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
			if (ch === '}') {
				this.pos++
				return obj
			}
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
			if (ch === ']') {
				this.pos++
				return arr
			}
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
		buf = lines.pop()! // keep incomplete last line
		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed) continue
			yield parse(trimmed)
		}
	}

	// Flush remaining buffer
	const trimmed = buf.trim()
	if (trimmed) yield parse(trimmed)
}

export default { stringify, parse, parseAll, parseStream }
export type { ParseError }
