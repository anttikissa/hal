// The call grammar (task 3fv): the cmd text of one native tool call.
//
//   NAME [/* purpose */] [arguments...]
//   [!!START
//   literal lines
//   !!END]
//
// Names are case-insensitive. Arguments are JS string literals, ASON
// objects or arrays (parsed, never evaluated), or bare words on the
// call's own line; values may span lines. A quoted string followed
// directly by more text keeps it ("src/a b.ts":1-9). /* comments */
// between arguments join, in order, into the purpose. Blank lines and #
// comment lines are skipped. One !!START block (task 0nt) carries a
// text argument byte-exact; a content line that is itself a marker takes
// one extra ! (!!!END). This module is syntax only: which argument fills
// which field belongs to each tool (host native-tool.ts).

import { ason } from './ason.ts'

export type Parsed = { name: string; raw: string; purpose?: string }
export type Values = { values: unknown[]; purpose?: string; unclosed?: true; block?: string }

const maxChars = 200_000
const one = 'one tool per call; make independent calls in parallel'

// A call-text failure quirks (task hq6) can recognize by its code.
function fail(code: string, message: string): never {
	throw Object.assign(new Error(message), { code })
}

// The line from `i` without its \r, as a marker would be written.
function lineAt(text: string, i: number): string {
	return text.slice(i, lineEnd(text, i)).replace(/\r$/, '')
}

// Whether `raw` holds a marker line, so it is block syntax, not prose.
function hasMarker(raw: string): boolean {
	return /^!!(START|END|NEW|OLD)\r?$/m.test(raw)
}

// The !!START block whose marker line begins at `i`: its content and the
// index after its !!END line.
function block(raw: string, i: number): { content: string; end: number } {
	let lines: string[] = []
	let at = lineEnd(raw, i) + 1
	while (at <= raw.length) {
		let line = lineAt(raw, at)
		let next = lineEnd(raw, at) + 1
		if (line === '!!END') return { content: lines.join('\n').replace(/\r$/, ''), end: Math.min(next, raw.length) }
		if (line === '!!START')
			fail(
				'block-nested',
				'!!START inside a block: close the first with !!END. A literal !!START line takes one extra ! (!!!START).',
			)
		lines.push(
			/^!!!+(START|END)\r?$/.test(raw.slice(at, next - 1)) ? raw.slice(at + 1, next - 1) : raw.slice(at, next - 1),
		)
		at = next
	}
	return fail('block-unclosed', '!!START block has no !!END line; each marker is a whole line.')
}

function lineEnd(text: string, i: number): number {
	let end = text.indexOf('\n', i)
	return end < 0 ? text.length : end
}

// Past whitespace, blank lines and # or // comment lines.
function blank(text: string, i: number): number {
	while (i < text.length) {
		if (/\s/.test(text[i]!)) i++
		else if (text[i] === '#' || text.startsWith('//', i)) i = lineEnd(text, i)
		else break
	}
	return i
}

function withoutLineComment(text: string): { text: string; purpose?: string } {
	let end = lineEnd(text, 0)
	for (let i = 0; i < end;) {
		if (text.startsWith('//', i) && (i === 0 || /\s/.test(text[i - 1]!)))
			return { text: text.slice(0, i).trimEnd() + text.slice(end), purpose: text.slice(i + 2, end).trim() }
		if ('{["\'`'.includes(text[i]!) && (i === 0 || /\s/.test(text[i - 1]!))) {
			try {
				i = ason.parseAt(text, i).end
			} catch {
				return { text }
			}
		} else if (text.startsWith('/*', i)) {
			let close = text.indexOf('*/', i + 2)
			i = close < 0 ? end : close + 2
		} else i++
	}
	return { text }
}

// The tool's name and the text after it.
function parse(input: unknown): Parsed {
	if (typeof input !== 'string') throw new Error('cmd must be a string, e.g. READ "src/main.ts"')
	if (input.length > maxChars) throw new Error(`cmd is ${input.length} characters; the most is ${maxChars}`)
	let { text, purpose } = withoutLineComment(input)
	let i = blank(text, 0)
	if (i >= text.length) throw new Error('empty tool call; e.g. READ "src/main.ts" or BASH "ls -l"')
	if (/^\/[A-Za-z]/.test(text.slice(i, i + 2))) return { name: 'command', raw: ' ' + text.slice(i) }
	let name = /^[A-Za-z_]+/.exec(text.slice(i, i + 64))?.[0]
	if (!name)
		throw new Error(`expected a tool name such as READ or BASH, found ${JSON.stringify(text.slice(i, i + 40))}`)
	let end = i + name.length
	if (end < text.length && !/\s/.test(text[end]!) && !text.startsWith('/*', end))
		throw new Error(`expected a space after ${name}, found ${JSON.stringify(text.slice(i, i + 40))}`)
	return { name: name.toLowerCase(), raw: text.slice(end), ...(purpose && { purpose }) }
}

// The arguments in `raw` and the purpose its comments give. An unclosed
// /* ends at its line end; `unclosed` says so, so a tool missing required
// arguments can blame it.
function values(raw: string): Values {
	let out: unknown[] = []
	let purposes: string[] = []
	let unclosed = false
	let firstLine = true
	let content: string | undefined
	let i = 0
	for (;;) {
		while (i < raw.length) {
			let c = raw[i]!
			if (c === '\n') {
				firstLine = false
				i++
			} else if (c === '!' && raw[i - 1] === '\n' && /^!!(START|END|NEW|OLD)$/.test(lineAt(raw, i))) {
				let marker = lineAt(raw, i)
				if (marker === '!!NEW')
					fail(
						'block-new',
						'!!NEW starts new text in EDIT; other tools take one block: a !!START line, literal lines, an !!END line.',
					)
				if (marker === '!!OLD') fail('block-old', '!!OLD belongs to EDIT; other tools take one !!START block.')
				if (marker === '!!END') fail('block-stray-end', '!!END without a !!START line before it.')
				if (content !== undefined) fail('block-two', `a call takes one !!START block; ${one}`)
				;({ content, end: i } = block(raw, i))
			} else if (/\s/.test(c)) i++
			else if (raw.startsWith('/*', i)) {
				let close = raw.indexOf('*/', i + 2)
				let stop = close < 0 ? lineEnd(raw, i) : close
				purposes.push(raw.slice(i + 2, stop).trim())
				if (close < 0) unclosed = true
				i = close < 0 ? stop : close + 2
			} else if ((c === '#' && !/^#t?\d+(?=\s|$)/.test(raw.slice(i))) || raw.startsWith('//', i)) i = lineEnd(raw, i)
			else break
		}
		if (i >= raw.length) break
		let c = raw[i]!
		if ('{["\'`'.includes(c)) {
			let parsed: ReturnType<typeof ason.parseAt>
			try {
				parsed = ason.parseAt(raw, i)
			} catch (e: any) {
				throw new Error(`argument ${out.length + 1}: ${e?.message ?? e}`)
			}
			i = parsed.end
			let value = parsed.value
			if (typeof value === 'string' && i < raw.length && !/\s/.test(raw[i]!) && !raw.startsWith('/*', i)) {
				let end = i
				while (end < raw.length && !/\s/.test(raw[end]!)) end++
				value += raw.slice(i, end)
				i = end
			}
			out.push(value)
		} else {
			let end = i
			while (end < raw.length && !/\s/.test(raw[end]!)) end++
			let word = raw.slice(i, end)
			if (!firstLine)
				throw new Error(`unexpected ${JSON.stringify(word)} on a later line: quote multi-line arguments; ${one}`)
			out.push(word)
			i = end
		}
	}
	let purpose = purposes.filter(Boolean).join(' ')
	return {
		values: out,
		...(purpose && { purpose }),
		...(unclosed && { unclosed: true as const }),
		...(content !== undefined && { block: content }),
	}
}

// The calls in `text`. A line starts a new call only when its first word
// is a tool name; any other line continues the call above it. Block
// content (!!START, or EDIT's !!OLD/!!NEW, to !!END) never starts one.
function split(text: string, isTool: (name: string) => boolean): string[] {
	callText.parse(text)
	if (!text.includes('\n')) return [text]
	let starts = [0],
		lineStart = true,
		first = true,
		block = false
	for (let i = 0; i < text.length;) {
		if (lineStart && (block || text[i] === '!')) {
			let end = lineEnd(text, i),
				line = lineAt(text, i)
			if (block || /^!!(START|OLD|NEW)$/.test(line)) {
				block = line !== '!!END'
				i = end < text.length ? end + 1 : end
				continue
			}
		}
		let c = text[i]!
		if (/\s/.test(c)) {
			if (c === '\n') lineStart = true
			i++
			continue
		}
		if (text.startsWith('/*', i)) {
			let close = text.indexOf('*/', i + 2)
			i = close < 0 ? lineEnd(text, i) : close + 2
			continue
		}
		if (c === '#' || text.startsWith('//', i)) {
			i = lineEnd(text, i)
			continue
		}
		let name = lineStart ? /^[A-Za-z_]+(?=\s|$|\/\*)/.exec(text.slice(i))?.[0] : undefined
		if (name && !first && !isTool(name.toLowerCase())) name = undefined
		if (name) {
			if (!first) starts.push(i)
			// EVAL's code without a block is literal text to the end (task v99).
			if (name.toLowerCase() === 'eval' && !/^[^\n]*\n!!START\r?(\n|$)/.test(text.slice(i))) break
		}
		first = false
		lineStart = false
		if ('{["\'`'.includes(c)) i = ason.parseAt(text, i).end
		else while (i < text.length && !/\s/.test(text[i]!)) i++
	}
	return starts.map((start, i) => text.slice(start, starts[i + 1]).trim())
}

export const callText = { parse, values, split, hasMarker, maxChars, withoutLineComment }
