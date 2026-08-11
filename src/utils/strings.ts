// Terminal string utilities: visual width, word wrap, clipping.
// See docs/terminal.md rule 4: no line may exceed terminal width.
const TAB_WIDTH = 4

/** Split text into lines. Handles both 'foo\nbar\n' and 'foo\nbar' → ['foo', 'bar']. */
export function toLines(text: string): string[] {
	if (!text) return []
	return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

/** Expand tabs to spaces at visual four-column stops without changing the source text. */
export function expandTabs(s: string, tabWidth = TAB_WIDTH): string {
	if (!s.includes('\t')) return s
	const lines: string[] = []
	for (const line of s.split('\n')) {
		let col = 0, last = 0
		lines.push(line.replaceAll('\t', function expand(_tab, offset) {
			col += visLen(line.slice(last, offset), col)
			const spaces = tabWidth - (col % tabWidth)
			col += spaces
			last = offset + 1
			return ' '.repeat(spaces)
		}))
	}
	return lines.join('\n')
}
function codePointLength(cp: number): number {
	return cp > 0xffff ? 2 : 1
}

/** Terminal display width of a Unicode code point without looking at neighbors. */
export function charWidth(cp: number): number {
	if (cp < 0x20) return 0
	if (cp < 0x7f) return 1
	// Style markers (PUA U+E000–E005): zero width, resolved to ANSI later
	if (cp >= 0xe000 && cp <= 0xe005) return 0
	if (isZeroWidth(cp)) return 0
	if (isWide(cp)) return 2
	return 1
}

/** Terminal display width and UTF-16 length for the glyph at `column`. */
export function glyphWidthAt(s: string, i: number, column = 0): { width: number; length: number } {
	const cp = s.codePointAt(i)!
	const length = codePointLength(cp)
	if (cp === 0x09) return { width: TAB_WIDTH - (column % TAB_WIDTH), length }
	if (s.codePointAt(i + length) === 0xfe0f && isVs16WideBase(cp)) {
		return { width: 2, length: length + 1 }
	}
	return { width: charWidth(cp), length }
}

function isZeroWidth(cp: number): boolean {
	return (
		(cp >= 0x0300 && cp <= 0x036f) ||
		(cp >= 0x1ab0 && cp <= 0x1aff) ||
		(cp >= 0x1dc0 && cp <= 0x1dff) ||
		(cp >= 0x20d0 && cp <= 0x20ff) ||
		(cp >= 0xfe00 && cp <= 0xfe0f) ||
		(cp >= 0xfe20 && cp <= 0xfe2f) ||
		cp === 0x200b ||
		cp === 0x200c ||
		cp === 0x200d ||
		cp === 0x2060 ||
		cp === 0xfeff ||
		(cp >= 0xe0100 && cp <= 0xe01ef)
	)
}

const BMP_WIDE_RANGES: Array<[number, number]> = [
	[0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
	[0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
	[0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
	[0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274e],
	[0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c],
	[0x2b50, 0x2b50], [0x2b55, 0x2b55],
]

const VS16_WIDE_BASES = new Set([0x2600, 0x2708, 0x2764, 0x26a0, 0x27a1, 0x2b05, 0x2b06, 0x2b07])

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
	for (const [from, to] of ranges) {
		if (cp >= from && cp <= to) return true
	}
	return false
}

function isVs16WideBase(cp: number): boolean {
	return VS16_WIDE_BASES.has(cp)
}

function isWide(cp: number): boolean {
	if (inRanges(cp, BMP_WIDE_RANGES)) return true
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xa960 && cp <= 0xa97c) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe10 && cp <= 0xfe6b) ||
		(cp >= 0xff01 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f000 && cp <= 0x1fbff) ||
		(cp >= 0x20000 && cp <= 0x3ffff)
	)
}

/** Visible width, with tabs advancing from `startColumn` to four-column stops. */
export function visLen(s: string, startColumn = 0): number {
	let n = startColumn,
		esc = false,
		osc = false
	for (let i = 0; i < s.length;) {
		const cp = s.codePointAt(i)!
		const cl = codePointLength(cp)
		if (cp === 0x1b) {
			esc = true
			i += cl
			continue
		}
		if (esc) {
			if (cp === 0x5d) {
				osc = true
				esc = false
			} else if (cp === 0x6d) esc = false
			i += cl
			continue
		}
		if (osc) {
			if (cp === 0x07) osc = false
			i += cl
			continue
		}
		const glyph = glyphWidthAt(s, i, n)
		n += glyph.width
		i += glyph.length
	}
	return n - startColumn
}

/** Word-wrap an ANSI string. Walks codepoints, skips escapes, breaks at word boundaries. */
export function wordWrap(text: string, width: number): string[] {
	if (width <= 0) return text.split('\n')
	const out: string[] = []
	for (const raw of text.split('\n')) {
		if (visLen(raw) <= width) {
			out.push(raw)
			continue
		}
		let vis = 0,
			wordStart = 0,
			lineStart = 0,
			esc = false,
			wrappedTrailingSpace = false
		for (let i = 0; i < raw.length; ) {
			const cp = raw.codePointAt(i)!
			const glyph = glyphWidthAt(raw, i, vis)
			const cl = glyph.length
			if (cp === 0x1b) {
				esc = true
				i += cl
				continue
			}
			if (esc) {
				if (cp === 0x6d) esc = false
				i += cl
				continue
			}
			if (cp === 0x20) wordStart = i
			vis += glyph.width
			if (vis > width) {
				const at = wordStart > lineStart ? wordStart : i
				out.push(raw.slice(lineStart, at))
				wrappedTrailingSpace = raw[at] === ' ' && at + 1 === raw.length
				lineStart = raw[at] === ' ' ? at + 1 : at
				wordStart = lineStart
				vis = visLen(raw.slice(lineStart, i + cl))
			}
			i += cl
		}
		if (lineStart < raw.length) out.push(raw.slice(lineStart))
		else if (wrappedTrailingSpace) out.push('')
	}
	return out
}

/** Clip string to fit within max visual width, adding '…' if truncated. ANSI-aware. */
export function clipVisual(s: string, max: number): string {
	if (max <= 0) return ''
	if (visLen(s) <= max) return s
	if (max === 1) return '…'
	// Walk codepoints, counting visual width, preserving ANSI/OSC escapes
	let vis = 0,
		esc = false,
		osc = false,
		cut = 0
	for (let i = 0; i < s.length; ) {
		const cp = s.codePointAt(i)!
		const glyph = glyphWidthAt(s, i, vis)
		const cl = glyph.length
		if (cp === 0x1b) {
			esc = true
			i += cl
			continue
		}
		if (esc) {
			if (cp === 0x5d) {
				osc = true
				esc = false
				i += cl
				continue
			}
			if (cp === 0x6d) esc = false
			i += cl
			continue
		}
		if (osc) {
			if (cp === 0x07) osc = false
			i += cl
			continue
		}
		if (vis + glyph.width > max - 1) {
			cut = i
			break
		}
		vis += glyph.width
		i += cl
	}
	return s.slice(0, cut) + '…'
}

/** Hard-wrap a string at exact column boundaries. ANSI-aware.
 *  Unlike wordWrap, doesn't try to break at spaces — just cuts at the column limit.
 *  Used for code blocks where breaking at word boundaries would be worse than mid-token. */
export function hardWrap(s: string, width: number): string[] {
	if (width <= 0) return [s]
	if (visLen(s) <= width) return [s]
	const out: string[] = []
	let vis = 0, lineStart = 0, esc = false, osc = false
	for (let i = 0; i < s.length; ) {
		const cp = s.codePointAt(i)!
		const glyph = glyphWidthAt(s, i, vis)
		const cl = glyph.length
		if (cp === 0x1b) { esc = true; i += cl; continue }
		if (esc) {
			if (cp === 0x5d) { osc = true; esc = false; i += cl; continue }
			if (cp === 0x6d) esc = false
			i += cl; continue
		}
		if (osc) { if (cp === 0x07) osc = false; i += cl; continue }
		if (vis + glyph.width > width) {
			out.push(s.slice(lineStart, i))
			lineStart = i
			vis = 0
		}
		vis += glyphWidthAt(s, i, vis).width
		i += cl
	}
	if (lineStart < s.length) out.push(s.slice(lineStart))
	return out
}

// ── Style markers ────────────────────────────────────────────────────────────
// PUA chars used as lightweight placeholders for ANSI style attributes.
// Markdown rendering (md.ts) emits these instead of raw ANSI so that
// wordWrap() can split lines freely. resolveMarkers() converts them to
// real ANSI, closing active styles at EOL and re-opening at BOL.
// Convention: even codepoint = ON, odd = OFF. OFF = ON + 1.

export const M_BOLD = '\uE000'
export const M_BOLD_OFF = '\uE001'
export const M_ITALIC = '\uE002'
export const M_ITALIC_OFF = '\uE003'

const MARKER_ANSI: Record<string, string> = {
	[M_BOLD]: '\x1b[1m',
	[M_BOLD_OFF]: '\x1b[22m',
	[M_ITALIC]: '\x1b[3m',
	[M_ITALIC_OFF]: '\x1b[23m',
}

/** Convert style markers to ANSI escapes, ensuring each line is
 *  self-contained. Active styles are closed at EOL and re-opened at BOL.
 *  Uses specific attribute resets (not \x1b[0m) so background color
 *  is never touched — safe for blocks with full-width backgrounds. */
export function resolveMarkers(lines: string[]): string[] {
	const active = new Set<string>()
	return lines.map((line) => {
		let out = ''
		// Re-open styles active from previous line
		for (const m of active) out += MARKER_ANSI[m]!
		// Walk chars: convert markers, track on/off state
		for (const ch of line) {
			const ansi = MARKER_ANSI[ch]
			if (ansi !== undefined) {
				out += ansi
				const cp = ch.codePointAt(0)!
				if ((cp & 1) === 0)
					active.add(ch) // even = ON
				else active.delete(String.fromCodePoint(cp - 1)) // odd = OFF
			} else {
				out += ch
			}
		}
		// Close active styles at EOL (specific resets, not full reset)
		for (const m of active) out += MARKER_ANSI[String.fromCodePoint(m.codePointAt(0)! + 1)]!
		return out
	})
}

export const strings = { charWidth, glyphWidthAt, visLen, wordWrap, hardWrap, clipVisual, resolveMarkers, expandTabs }
