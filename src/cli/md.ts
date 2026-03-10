// Mini markdown → ANSI for LLM output.
// Block-level: ```code fences```, | tables |
// Inline: **bold**, *italic*, `code`, # headers

export { charWidth, visLen, wordWrap, clipVisual } from '../utils/strings.ts'

export interface MdColors {
	bold: [on: string, off: string]
	italic: [on: string, off: string]
	code: [on: string, off: string]
}

const DEFAULT_COLORS: MdColors = {
	bold: ['\x1b[1m', '\x1b[22m'],
	italic: ['\x1b[3m', '\x1b[23m'],
	code: ['\x1b[2m', '\x1b[22m'],
}

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
export function mdInline(line: string, colors?: MdColors): string {
	const c = colors ?? DEFAULT_COLORS
	const hm = line.match(/^(#{1,6})\s+(.*)/)
	if (hm) return `${c.bold[0]}${inlineSpans(hm[2], c)}${c.bold[1]}`
	return inlineSpans(line, c)
}

function inlineSpans(s: string, c: MdColors): string {
	return s
		.replace(/\*\*`([^`]+)`\*\*/g, `${c.bold[0]}$1${c.bold[1]}`)
		.replace(/`([^`\n]+)`/g, `${c.code[0]}$1${c.code[1]}`)
		.replace(/\*\*(.+?)\*\*/g, `${c.bold[0]}$1${c.bold[1]}`)
		.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, `${c.italic[0]}$1${c.italic[1]}`)
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
