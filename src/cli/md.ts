// Mini markdown → ANSI renderer for LLM output.
//
// Block-level: ```code fences```, | tables |
// Inline: **bold**, *italic*, `code`, # headers
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
	M_DIM,
	M_DIM_OFF,
} from '../utils/strings.ts'

// ── ANSI style pairs ─────────────────────────────────────────────────────────

export interface MdColors {
	bold: [on: string, off: string]
	italic: [on: string, off: string]
	code: [on: string, off: string]
}

const DEFAULT_COLORS: MdColors = {
	bold: [M_BOLD, M_BOLD_OFF],
	italic: [M_ITALIC, M_ITALIC_OFF],
	code: [M_DIM, M_DIM_OFF],
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

/** Apply inline markdown: **bold**, *italic*, `code`, # headers. */
function mdInline(line: string, colors?: MdColors): string {
	const c = colors ?? DEFAULT_COLORS

	// Headers: # through ######
	const hm = line.match(/^(#{1,6})\s+(.*)/)
	if (hm) return `${c.bold[0]}${inlineSpans(hm[2]!, c)}${c.bold[1]}`

	return inlineSpans(line, c)
}

function inlineSpans(s: string, c: MdColors): string {
	// Step 1: Extract code spans into numbered placeholders so that
	// bold/italic regexes can't see characters inside backticks.
	// E.g. `state/sessions/*/foo` won't trigger italic on the *.
	const codes: string[] = []
	const ph = (i: number) => `\x00C${i}\x00`

	// **`bold code`** → bold only (no dim code style)
	s = s.replace(/\*\*`([^`]+)`\*\*/g, (_, g) => {
		const i = codes.length
		codes.push(`${c.bold[0]}${g}${c.bold[1]}`)
		return ph(i)
	})

	// `inline code`
	s = s.replace(/`([^`\n]+)`/g, (_, g) => {
		const i = codes.length
		codes.push(`${c.code[0]}${g}${c.code[1]}`)
		return ph(i)
	})

	// **bold**
	s = s.replace(/\*\*(.+?)\*\*/g, `${c.bold[0]}$1${c.bold[1]}`)

	// *italic* — but not **bold** stars (negative lookbehind/lookahead)
	s = s.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, `${c.italic[0]}$1${c.italic[1]}`)

	// Step 2: Restore code span placeholders
	s = s.replace(/\x00C(\d+)\x00/g, (_, i) => codes[+i]!)

	return s
}

// ── Table formatting ─────────────────────────────────────────────────────────

/** Pad an ANSI string to a target visual width with trailing spaces.
 *  Can't use padEnd() because it counts ANSI escape bytes. */
function visPad(s: string, targetWidth: number): string {
	return s + ' '.repeat(Math.max(0, targetWidth - visLen(s)))
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

	// Compute final column widths. If everything fits, use natural widths.
	// Otherwise shrink proportionally, with a minimum of 1 per column.
	const totalNatural = naturalWidths.reduce((a, b) => a + b, 0)
	let colWidths: number[]

	if (totalNatural <= availableForCells) {
		colWidths = naturalWidths
	} else {
		// Start at minimum 1 per column, distribute remaining space
		// proportionally to natural width.
		colWidths = new Array(numCols).fill(1)
		const extra = Math.max(0, availableForCells - numCols)
		if (extra > 0 && totalNatural > 0) {
			// Proportional distribution
			for (let i = 0; i < numCols; i++) {
				colWidths[i] = Math.max(1, Math.floor((naturalWidths[i]! / totalNatural) * availableForCells))
			}
			// Distribute rounding remainder
			let allocated = colWidths.reduce((a, b) => a + b, 0)
			let remaining = availableForCells - allocated
			for (let i = 0; remaining > 0 && i < numCols; i++) {
				if (colWidths[i]! < naturalWidths[i]!) {
					colWidths[i]!++
					remaining--
				}
			}
		}
	}

	// ── Wrap cells that exceed their column width ────────────────────────
	// Each cell becomes string[] (one entry per visual line).
	// resolveMarkers() here so styles don't leak into border chars.
	function wrapCell(lines: string[], colWidth: number): string[] {
		const out: string[] = []
		for (const line of lines.length > 0 ? lines : ['']) {
			if (visLen(line) <= colWidth) out.push(...resolveMarkers([line]))
			else out.push(...resolveMarkers(wordWrap(line, colWidth)))
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
