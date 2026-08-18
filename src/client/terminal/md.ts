// Mini markdown → ANSI renderer for LLM output.
//
// Block-level: ```code fences```, | tables |
// Inline: **bold**, *italic*, `code`, [links](https://example.com), # headers
//
// Design: parse first (mdSpans), render second (mdInline/mdTable).
// The caller (render.ts) decides word-wrapping and layout per span type:
//   text spans  → mdInline() each line, then wordWrap()
//   code spans  → no inline processing, preserve whitespace
//   table spans → mdTable() applies mdInline() AND aligns columns
//                 (caller should NOT call mdInline again on table output)

import {
	visLen,
	wordWrap,
	resolveMarkers,
	M_BOLD,
	M_BOLD_OFF,
	M_ITALIC,
	M_ITALIC_OFF,
} from '../../utils/strings.ts'

// ── ANSI style pairs ─────────────────────────────────────────────────────────

export interface MdColors {
	bold: [on: string, off: string]
	italic: [on: string, off: string]
	code: [on: string, off: string]
}

const DEFAULT_COLORS: MdColors = {
	bold: [M_BOLD, M_BOLD_OFF],
	italic: [M_ITALIC, M_ITALIC_OFF],
	code: ['', ''],
}

// ── Block-level: split into spans ────────────────────────────────────────────

export type MdSpan =
	| { type: 'text'; lines: string[] }
	| { type: 'code'; lang: string; lines: string[] }
	| { type: 'table'; lines: string[] }

/** Split markdown text into typed spans (text, code fences, tables). */
function mdSpans(text: string): MdSpan[] {
	const spans: MdSpan[] = []
	let buf: string[] = []
	let inCode = false
	let codeLang = ''

	const flushText = () => {
		if (buf.length) {
			spans.push({ type: 'text', lines: buf })
			buf = []
		}
	}

	for (const line of text.split('\n')) {
		// Opening or closing code fence: ```lang or ```
		if (line.startsWith('```')) {
			if (inCode) {
				// Closing fence
				spans.push({ type: 'code', lang: codeLang, lines: buf })
				buf = []
				inCode = false
				codeLang = ''
			} else {
				// Opening fence — flush any preceding text
				flushText()
				codeLang = line.slice(3).trim()
				inCode = true
			}
			continue
		}

		if (inCode) {
			buf.push(line)
			continue
		}

		// Table row: starts and ends with |
		if (/^\|.+\|$/.test(line.trim())) {
			flushText()
			const last = spans[spans.length - 1]
			if (last?.type === 'table') {
				last.lines.push(line)
			} else {
				spans.push({ type: 'table', lines: [line] })
			}
			continue
		}

		buf.push(line)
	}

	// Flush remaining. Unclosed code fence stays as code.
	if (buf.length) {
		spans.push({ type: inCode ? 'code' : 'text', ...(inCode ? { lang: codeLang } : {}), lines: buf } as MdSpan)
	}

	return spans
}

// ── Inline formatting ────────────────────────────────────────────────────────

/** Apply inline markdown: **bold**, *italic*, `code`, # headers, links.
 *  Supports backslash-escaped literal markdown markers like \* and \`. */
function mdInline(line: string, colors?: MdColors): string {
	const c = colors ?? DEFAULT_COLORS
	const escaped: string[] = []
	const ph = (i: number) => `\x00E${i}\x00`

	// Code spans come first because Markdown treats backslashes in them literally.
	line = line.replace(/`[^`\n]+`|\\([\\`*#\[\]()])/g, (match, marker) => {
		if (!marker) return match
		const i = escaped.length
		escaped.push(marker)
		return ph(i)
	})

	// Headers: # through ######
	const hm = line.match(/^(#{1,6})\s+(.*)/)
	const rendered = hm ? `${c.bold[0]}${inlineSpans(hm[2]!, c)}${c.bold[1]}` : inlineSpans(line, c)
	return rendered.replace(/\x00E(\d+)\x00/g, (_, i) => escaped[+i]!)
}

function emphasis(s: string, c: MdColors): string {
	s = s.replace(/\*\*(.+?)\*\*/g, `${c.bold[0]}$1${c.bold[1]}`)
	return s.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, `${c.italic[0]}$1${c.italic[1]}`)
}

function inlineSpans(s: string, c: MdColors): string {
	// Extract code and links before emphasis so markdown-looking characters in
	// their contents cannot affect surrounding text.
	const codes: string[] = []
	const codePh = (i: number) => `\x00C${i}\x00`

	// **`bold code`** → bold only (no dim code style)
	s = s.replace(/\*\*`([^`]+)`\*\*/g, (_, g) => {
		const i = codes.length
		codes.push(`${c.bold[0]}${g}${c.bold[1]}`)
		return codePh(i)
	})

	// `inline code`
	s = s.replace(/`([^`\n]+)`/g, (_, g) => {
		const i = codes.length
		codes.push(`${c.code[0]}${g}${c.code[1]}`)
		return codePh(i)
	})

	const links: Array<{ label: string; url: string }> = []
	const linkPh = (i: number) => `\x00L${i}\x00`
	s = s.replace(/(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^\s)\x00-\x1f]+)\)/g, (_, label, url) => {
		const i = links.length
		links.push({ label, url })
		return linkPh(i)
	})

	s = emphasis(s, c)

	// Labels can contain emphasis and code placeholders. Restore links first so
	// the final code pass also reaches placeholders inside labels.
	s = s.replace(/\x00L(\d+)\x00/g, (_, rawIndex) => {
		const link = links[+rawIndex]!
		return `\x1b]8;;${link.url}\x07${emphasis(link.label, c)}\x1b]8;;\x07`
	})
	return s.replace(/\x00C(\d+)\x00/g, (_, i) => codes[+i]!)
}

// ── Table formatting ─────────────────────────────────────────────────────────

/** Pad an ANSI string to a target visual width with trailing spaces.
 *  Can't use padEnd() because it counts ANSI escape bytes. */
function visPad(s: string, targetWidth: number): string {
	return s + ' '.repeat(Math.max(0, targetWidth - visLen(s)))
}

function longestWordWidth(lines: string[]): number {
	let width = 1
	for (const line of lines) {
		for (const word of line.split(/\s+/)) {
			if (!word) continue
			width = Math.max(width, visLen(word))
		}
	}
	return width
}

function shrinkColumns(widths: number[], floors: number[], excess: number): number {
	while (excess > 0) {
		let totalShrinkable = 0
		for (let i = 0; i < widths.length; i++) {
			totalShrinkable += Math.max(0, widths[i]! - floors[i]!)
		}
		if (totalShrinkable === 0) break

		for (let i = 0; i < widths.length && excess > 0; i++) {
			const shrinkable = Math.max(0, widths[i]! - floors[i]!)
			if (shrinkable === 0) continue
			const proportional = Math.floor((shrinkable / totalShrinkable) * excess)
			const shrink = Math.min(shrinkable, Math.max(1, proportional), excess)
			widths[i]! -= shrink
			excess -= shrink
		}
	}
	return excess
}

function fitColumnWidths(naturalWidths: number[], minWidths: number[], availableForCells: number): number[] {
	const widths = [...naturalWidths]
	const totalNatural = naturalWidths.reduce((a, b) => a + b, 0)
	let excess = totalNatural - availableForCells
	if (excess <= 0) return widths

	// Prefer wrapping prose before breaking identifiers. The first floor is each
	// column's longest whitespace-delimited word, matching wordWrap() behavior.
	excess = shrinkColumns(widths, minWidths, excess)
	if (excess > 0) {
		// If the terminal is too narrow even for every word, fall back to hard cuts.
		excess = shrinkColumns(widths, new Array(widths.length).fill(1), excess)
	}
	return widths
}

function activeAfterStyle(s: string, active: boolean, on: string, off: string): boolean {
	let i = 0
	while (i < s.length) {
		const onAt = on ? s.indexOf(on, i) : -1
		const offAt = off ? s.indexOf(off, i) : -1
		if (onAt === -1 && offAt === -1) break
		if (offAt === -1 || (onAt !== -1 && onAt < offAt)) {
			active = true
			i = onAt + on.length
		} else {
			active = false
			i = offAt + off.length
		}
	}
	return active
}

function containWrappedAnsiStyle(lines: string[], style?: [on: string, off: string]): string[] {
	if (!style?.[0] || !style[1]) return lines
	const [on, off] = style
	const out: string[] = []
	let active = false
	for (const line of lines) {
		const startsActive = active
		active = activeAfterStyle(line, active, on, off)
		let fixed = startsActive ? `${on}${line}` : line
		if (active) fixed += off
		out.push(fixed)
	}
	return out
}

/** Render a markdown table with box-drawing borders.
 *
 *  - Applies mdInline() to each cell (so **bold** renders as bold, not raw stars)
 *  - Measures with visLen() (ANSI-aware, emoji-aware)
 *  - Shrinks columns proportionally when the table exceeds `width`
 *  - Wraps cell content within column boundaries when shrunk
 *  - Returns fully formatted lines — caller should NOT call mdInline() again.
 *
 *  Border anatomy for N columns:
 *    "│ " + cell + " │ " + cell + " │"
 *    overhead = 2 + (N-1)*3 + 2 = 3N + 1                                   */
function mdTable(lines: string[], width: number, colors?: MdColors): string[] {
	// Parse: strip outer pipes, split by |, trim each cell.
	// Filter out separator rows (|---|---|).
	// Cells may contain <br> to force a line break inside a single table cell.
	const rawRows = lines
		.filter((l) => !/^\|[\s\-:|]+\|$/.test(l.trim()))
		.map((l) =>
			l
				.replace(/^\||\|$/g, '')
				.split('|')
				.map((c) => c.trim().split(/<br\s*\/?>/i)),
		)
	if (!rawRows.length) return []

	// Apply inline markdown to each physical line inside each cell.
	const rendered = rawRows.map((row) => row.map((cell) => cell.map((line) => mdInline(line, colors))))

	const numCols = Math.max(...rendered.map((r) => r.length))
	if (numCols === 0) return []

	// Border overhead: "│ " + cell + (" │ " + cell)*(N-1) + " │" = 3N + 1
	const borderOverhead = 3 * numCols + 1
	const availableForCells = width - borderOverhead

	// Natural width = what each column wants (max visible line in any cell).
	const naturalWidths = Array.from({ length: numCols }, (_, i) =>
		Math.max(
			...rendered.map((r) => Math.max(...(r[i] ?? ['']).map((line) => visLen(line)))),
		),
	)

	// Compute final column widths. If the table needs to shrink, protect each
	// column's longest word before giving remaining width to prose columns.
	const minWidths = Array.from({ length: numCols }, (_, i) =>
		longestWordWidth(rendered.flatMap((r) => r[i] ?? [''])),
	)
	const colWidths = fitColumnWidths(naturalWidths, minWidths, availableForCells)

	// ── Wrap cells that exceed their column width ────────────────────────
	// Each cell becomes string[] (one entry per visual line).
	// resolveMarkers() here so styles don't leak into border chars.
	function wrapCell(lines: string[], colWidth: number): string[] {
		const out: string[] = []
		for (const line of lines.length > 0 ? lines : ['']) {
			const wrapped = visLen(line) <= colWidth ? [line] : wordWrap(line, colWidth)
			out.push(...resolveMarkers(containWrappedAnsiStyle(wrapped, colors?.code)))
		}
		return out.length > 0 ? out : ['']
	}

	// ── Build output with box-drawing borders ────────────────────────────
	const out: string[] = []
	const hRule = (left: string, mid: string, right: string) =>
		left + colWidths.map((w) => '─'.repeat(w + 2)).join(mid) + right

	out.push(hRule('┌', '┬', '┐'))

	for (let rowIdx = 0; rowIdx < rendered.length; rowIdx++) {
		const row = rendered[rowIdx]!
		// Wrap each cell into lines, preserving explicit <br> breaks.
		const cellLines = Array.from({ length: numCols }, (_, ci) => wrapCell(row[ci] ?? [''], colWidths[ci]!))
		const rowHeight = Math.max(...cellLines.map((cl) => cl.length))

		// Emit each visual line of this row
		for (let li = 0; li < rowHeight; li++) {
			const parts = cellLines.map((cl, ci) => visPad(cl[li] ?? '', colWidths[ci]!))
			out.push('│ ' + parts.join(' │ ') + ' │')
		}

		// Separator after every row except the last
		if (rowIdx < rendered.length - 1) {
			out.push(hRule('├', '┼', '┤'))
		}
	}

	out.push(hRule('└', '┴', '┘'))
	return out
}

// ── Namespace ────────────────────────────────────────────────────────────────

export const md = { mdSpans, mdInline, mdTable }
