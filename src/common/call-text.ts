// The call grammar (task 3fv): the cmd text of one native tool call.
//
//   NAME [/* purpose */] [arguments...]
//
// Names are case-insensitive. Arguments are JS string literals, ASON
// objects or arrays (parsed, never evaluated), or bare words on the
// call's own line; values may span lines. A quoted string followed
// directly by more text keeps it ("src/a b.ts":1-9). /* comments */
// between arguments join, in order, into the purpose. Blank lines and #
// comment lines are skipped. This module is syntax only: which argument
// fills which field belongs to each tool (host native-tool.ts).

import { ason } from './ason.ts'

export type Parsed = { name: string; raw: string }
export type Values = { values: unknown[]; purpose?: string; unclosed?: true }

const maxChars = 200_000
const one = 'one tool per call; make independent calls in parallel'

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

// The tool's name and the text after it.
function parse(text: unknown): Parsed {
	if (typeof text !== 'string') throw new Error('cmd must be a string, e.g. READ "src/main.ts"')
	if (text.length > maxChars) throw new Error(`cmd is ${text.length} characters; the most is ${maxChars}`)
	let i = blank(text, 0)
	if (i >= text.length) throw new Error('empty tool call; e.g. READ "src/main.ts" or BASH "ls -l"')
	let name = /^[A-Za-z_]+/.exec(text.slice(i, i + 64))?.[0]
	if (!name) throw new Error(`expected a tool name such as READ or BASH, found ${JSON.stringify(text.slice(i, i + 40))}`)
	let end = i + name.length
	if (end < text.length && !/\s/.test(text[end]!) && !text.startsWith('/*', end)) throw new Error(`expected a space after ${name}, found ${JSON.stringify(text.slice(i, i + 40))}`)
	return { name: name.toLowerCase(), raw: text.slice(end) }
}

// The arguments in `raw` and the purpose its comments give. An unclosed
// /* ends at its line end; `unclosed` says so, so a tool missing required
// arguments can blame it.
function values(raw: string): Values {
	let out: unknown[] = []
	let purposes: string[] = []
	let unclosed = false
	let firstLine = true
	let i = 0
	for (;;) {
		while (i < raw.length) {
			let c = raw[i]!
			if (c === '\n') { firstLine = false; i++ }
			else if (/\s/.test(c)) i++
			else if (raw.startsWith('/*', i)) {
				let close = raw.indexOf('*/', i + 2)
				let stop = close < 0 ? lineEnd(raw, i) : close
				purposes.push(raw.slice(i + 2, stop).trim())
				if (close < 0) unclosed = true
				i = close < 0 ? stop : close + 2
			} else if (c === '#' && !/^#t?\d+(?=\s|$)/.test(raw.slice(i)) || raw.startsWith('//', i)) i = lineEnd(raw, i)
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
			if (!firstLine) throw new Error(`unexpected ${JSON.stringify(word)} on a later line: quote multi-line arguments; ${one}`)
			out.push(word)
			i = end
		}
	}
	let purpose = purposes.filter(Boolean).join(' ')
	return { values: out, ...(purpose && { purpose }), ...(unclosed && { unclosed: true as const }) }
}

function split(text: string): string[] {
	callText.parse(text)
	if (!text.includes('\n')) return [text]
	let starts = [0], lineStart = true, first = true, edit = false, block = false
	for (let i = 0; i < text.length;) {
		if (lineStart && edit && (block || text[i] === '!')) {
			let end = lineEnd(text, i), line = text.slice(i, end).replace(/\r$/, '')
			if (block || /^!!(OLD|NEW)$/.test(line)) {
				block = line !== '!!END'
				i = end < text.length ? end + 1 : end
				continue
			}
		}
		let c = text[i]!
		if (/\s/.test(c)) { if (c === '\n') lineStart = true; i++; continue }
		if (text.startsWith('/*', i)) {
			let close = text.indexOf('*/', i + 2)
			i = close < 0 ? lineEnd(text, i) : close + 2
			continue
		}
		if (c === '#' || text.startsWith('//', i)) { i = lineEnd(text, i); continue }
		let name = lineStart ? /^[A-Za-z_]+(?=\s|$|\/\*)/.exec(text.slice(i))?.[0] : undefined
		if (name) {
			if (!first) starts.push(i)
			edit = name.toLowerCase() === 'edit'
		}
		first = false
		lineStart = false
		if ('{["\'`'.includes(c)) i = ason.parseAt(text, i).end
		else while (i < text.length && !/\s/.test(text[i]!)) i++
	}
	return starts.map((start, i) => text.slice(start, starts[i + 1]).trim())
}

export const callText = { parse, values, split, maxChars }
