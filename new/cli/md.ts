// Mini markdown → ANSI for LLM output.
// Block-level: ```code fences```, | tables |
// Inline: **bold**, *italic*, `code`, # headers

const B1 = '\x1b[1m', B0 = '\x1b[22m'
const I1 = '\x1b[3m', I0 = '\x1b[23m'
const D1 = '\x1b[2m', D0 = '\x1b[22m'

export type MdSpan =
	| { type: 'text'; lines: string[] }
	| { type: 'code'; lines: string[] }
	| { type: 'table'; lines: string[] }

/** Split markdown text into typed spans. */
export function mdSpans(text: string): MdSpan[] {
	const spans: MdSpan[] = []
	let buf: string[] = []
	let inCode = false
	const flush = () => { if (buf.length) { spans.push({ type: 'text', lines: buf }); buf = [] } }
	for (const line of text.split('\n')) {
		if (line.startsWith('```')) {
			if (inCode) { spans.push({ type: 'code', lines: buf }); buf = [] }
			else flush()
			inCode = !inCode
			continue
		}
		if (inCode) { buf.push(line); continue }
		if (/^\|.+\|$/.test(line.trim())) {
			flush()
			const last = spans[spans.length - 1]
			if (last?.type === 'table') last.lines.push(line)
			else spans.push({ type: 'table', lines: [line] })
		} else buf.push(line)
	}
	if (buf.length) spans.push({ type: inCode ? 'code' : 'text', lines: buf })
	return spans
}

/** Inline markdown: **bold**, *italic*, `code`, # headers. */
export function mdInline(line: string): string {
	const hm = line.match(/^(#{1,6})\s+(.*)/)
	if (hm) return `${B1}${inlineSpans(hm[2])}${B0}`
	return inlineSpans(line)
}

function inlineSpans(s: string): string {
	return s
		.replace(/\*\*`([^`]+)`\*\*/g, `${B1}$1${B0}`)
		.replace(/`([^`\n]+)`/g, `${D1}$1${D0}`)
		.replace(/\*\*(.+?)\*\*/g, `${B1}$1${B0}`)
		.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, `${I1}$1${I0}`)
}

/** Format table: align columns, skip separator rows. */
export function mdTable(lines: string[]): string[] {
	const rows = lines
		.filter(l => !/^\|[\s\-:|]+\|$/.test(l.trim()))
		.map(l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
	if (!rows.length) return []
	const cols = Math.max(...rows.map(r => r.length))
	const w = Array.from({ length: cols }, (_, i) =>
		Math.max(...rows.map(r => (r[i] ?? '').length)))
	return rows.map(row =>
		'  ' + row.map((c, i) => c.padEnd(w[i] ?? 0)).join('  '))
}

/** Visible length of string (ignoring ANSI escapes). */
export function visLen(s: string): number {
	let n = 0, esc = false
	for (let i = 0; i < s.length; i++) {
		if (s[i] === '\x1b') { esc = true; continue }
		if (esc) { if (s[i] === 'm') esc = false; continue }
		n++
	}
	return n
}

/** Word-wrap an ANSI string. Walks chars, skips escapes, breaks at word boundaries. */
export function wordWrap(text: string, width: number): string[] {
	if (width <= 0) return text.split('\n')
	const out: string[] = []
	for (const raw of text.split('\n')) {
		if (visLen(raw) <= width) { out.push(raw); continue }
		let vis = 0, wordStart = 0, lineStart = 0, esc = false
		for (let i = 0; i < raw.length; i++) {
			if (raw[i] === '\x1b') { esc = true; continue }
			if (esc) { if (raw[i] === 'm') esc = false; continue }
			if (raw[i] === ' ') wordStart = i
			if (++vis > width) {
				const at = wordStart > lineStart ? wordStart : i
				out.push(raw.slice(lineStart, at))
				lineStart = raw[at] === ' ' ? at + 1 : at
				wordStart = lineStart
				vis = visLen(raw.slice(lineStart, i + 1))
			}
		}
		if (lineStart < raw.length) out.push(raw.slice(lineStart))
	}
	return out
}
