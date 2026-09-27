// Terminal string widths, wrapping and clipping: the one place that
// knows how many columns text takes. No frame line may exceed the
// terminal width, and source offsets (.length) are never columns.
//
// Widths follow what Ghostty draws: wide East Asian and emoji glyphs take
// two columns, combining marks and joiners none, and a grapheme cluster
// (ZWJ sequence, flag, skin tone) takes the width of its first glyph.
// Tabs advance to four-column stops. ANSI CSI and OSC sequences are
// invisible.

const TAB_WIDTH = 4

function codePointLength(cp: number): number {
	return cp > 0xffff ? 2 : 1
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
		(cp >= 0x1f3fb && cp <= 0x1f3ff) ||
		(cp >= 0xe0000 && cp <= 0xe007f) ||
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

// Text-presentation symbols that become wide emoji when followed by VS16.
const VS16_WIDE_BASES = new Set([0x2600, 0x263a, 0x2708, 0x2764, 0x26a0, 0x27a1, 0x2b05, 0x2b06, 0x2b07])

function isWide(cp: number): boolean {
	for (let [from, to] of BMP_WIDE_RANGES) if (cp >= from && cp <= to) return true
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

const isRegional = (cp: number | undefined) => cp !== undefined && cp >= 0x1f1e6 && cp <= 0x1f1ff

/** Display width of one code point, ignoring its neighbours. */
function charWidth(cp: number): number {
	if (cp < 0x20) return 0
	if (cp < 0x7f) return 1
	if (isZeroWidth(cp)) return 0
	if (isWide(cp)) return 2
	return 1
}

/**
 * Width and UTF-16 length of the glyph starting at `i` when drawn at
 * `column`. The glyph extends over a whole flag (regional indicator pair)
 * and over ZWJ-joined code points, which draw inside the first one.
 */
function glyphAt(s: string, i: number, column = 0): { width: number; length: number } {
	let cp = s.codePointAt(i)!
	let length = codePointLength(cp)
	if (cp === 0x09) return { width: TAB_WIDTH - (column % TAB_WIDTH), length }
	let width = charWidth(cp)
	if (isRegional(cp) && isRegional(s.codePointAt(i + length))) return { width: 2, length: length + 2 }
	if (s.codePointAt(i + length) === 0xfe0f && VS16_WIDE_BASES.has(cp)) {
		width = 2
		length++
	}
	if (width === 0) return { width, length }
	// Marks, selectors and modifiers after the base, and code points
	// joined to it by ZWJ, draw inside it.
	for (;;) {
		let next = s.codePointAt(i + length)
		if (next === undefined) break
		if (next === 0x200d) {
			let joined = s.codePointAt(i + length + 1)
			length += 1 + (joined === undefined ? 0 : codePointLength(joined))
		} else if (next >= 0x20 && isZeroWidth(next)) length += codePointLength(next)
		else break
	}
	return { width, length }
}

// Offset just past the escape sequence at i (CSI, OSC or a two-byte
// escape), or i itself when there is none.
function skipEscape(s: string, i: number): number {
	if (s.charCodeAt(i) !== 0x1b) return i
	let next = s[i + 1]
	if (next === '[') {
		// Parameters, then one final byte 0x40–0x7e.
		let j = i + 2
		while (j < s.length && (s.charCodeAt(j) < 0x40 || s.charCodeAt(j) > 0x7e)) j++
		return Math.min(s.length, j + 1)
	}
	if (next === ']') {
		// Ends with BEL or ST.
		for (let j = i + 2; j < s.length; j++) {
			if (s[j] === '\x07') return j + 1
			if (s[j] === '\x1b' && s[j + 1] === '\\') return j + 2
		}
		return s.length
	}
	return Math.min(s.length, i + 2)
}

// Walks s, calling visit for each visible glyph with its start offset,
// width, length and column. visit returns false to stop. Returns the
// offset where the walk stopped.
function walk(s: string, column: number, visit: (i: number, width: number, length: number, column: number) => boolean | void): number {
	let i = 0
	while (i < s.length) {
		let j = strings.skipEscape(s, i)
		if (j > i) {
			i = j
			continue
		}
		let g = strings.glyphAt(s, i, column)
		if (visit(i, g.width, g.length, column) === false) return i
		column += g.width
		i += g.length
	}
	return i
}

/** Visible width, with tabs advancing from `startColumn` to four-column stops. */
function visLen(s: string, startColumn = 0): number {
	let n = 0
	strings.walk(s, startColumn, (_i, w) => {
		n += w
	})
	return n
}

/** Expand tabs to the spaces they display as. */
function expandTabs(s: string): string {
	if (!s.includes('\t')) return s
	return s
		.split('\n')
		.map((line) => {
			let out = ''
			let last = 0
			strings.walk(line, 0, (i, w, len) => {
				if (line[i] !== '\t') return
				out += line.slice(last, i) + ' '.repeat(w)
				last = i + len
			})
			return out + line.slice(last)
		})
		.join('\n')
}

// Keep OSC 8 links self-contained so a repaint of one row cannot leak a
// link into its neighbours. The visible text is unchanged.
function containLinks(lines: string[]): string[] {
	let active = ''
	let close = '\x1b]8;;\x07'
	return lines.map((source) => {
		let line = active ? `\x1b]8;;${active}\x07${source}` : source
		// OSC 8 is ESC ] 8 ; params ; URI BEL; an empty URI closes.
		for (let i = line.indexOf('\x1b]8;'); i >= 0; i = line.indexOf('\x1b]8;', i + 1)) {
			let uri = line.indexOf(';', i + 4) + 1
			let end = line.indexOf('\x07', uri)
			if (uri > 0 && end >= 0) active = line.slice(uri, end)
		}
		return active ? line + close : line
	})
}

/**
 * Wrap each line of text to at most `width` columns, breaking after
 * spaces where possible and mid-word otherwise. A space at a break is
 * dropped. Escape sequences are kept and never counted.
 */
function wordWrap(text: string, width: number): string[] {
	if (width <= 0) return text.split('\n')
	let out: string[] = []
	for (let raw of text.split('\n')) {
		if (strings.visLen(raw) <= width) {
			out.push(raw)
			continue
		}
		// Columns count from the start of the current row, so tab stops
		// are where that row will draw them.
		let lineStart = 0
		let col = 0
		// Offset just past the last space on this row.
		let breakAt = -1
		let i = 0
		while (i < raw.length) {
			let j = strings.skipEscape(raw, i)
			if (j > i) {
				i = j
				continue
			}
			let g = strings.glyphAt(raw, i, col)
			if (col + g.width > width && i > lineStart && raw[i] === ' ') {
				// The space that overflows is the break.
				out.push(raw.slice(lineStart, i))
				lineStart = breakAt = i + 1
				col = 0
				i++
				continue
			}
			// Break after the last space, or else right here; the part
			// carried over may itself need another break.
			while (col + g.width > width && i > lineStart) {
				if (breakAt > lineStart) {
					out.push(raw.slice(lineStart, breakAt - 1))
					lineStart = breakAt
				} else {
					out.push(raw.slice(lineStart, i))
					lineStart = i
				}
				col = strings.visLen(raw.slice(lineStart, i))
				g = strings.glyphAt(raw, i, col)
			}
			col += g.width
			if (raw[i] === ' ') breakAt = i + 1
			i += g.length
		}
		if (lineStart < raw.length) out.push(raw.slice(lineStart))
	}
	return strings.containLinks(out)
}

// Text from the model, tools or a paste must not drive the terminal:
// control characters other than newline and tab become visible. Keeps
// offsets, so a prompt cursor still points at the same place.
function clean(s: string): string {
	return s.replace(/(?![\n\t])\p{Cc}/gu, '\ufffd')
}

/** Clip to at most `max` columns, ending with '…' if anything was cut. */
function clipVisual(s: string, max: number): string {
	if (max <= 0) return ''
	if (strings.visLen(s) <= max) return s
	let cut = strings.walk(s, 0, (_i, w, _len, col) => col + w <= max - 1)
	return s.slice(0, cut) + '…'
}

/**
 * The visible columns [from, to) of s, opening with every escape seen
 * before `from` so the styling active there carries over. A wide glyph
 * cut by either edge becomes spaces. Tabs must already be expanded.
 */
function sliceVisual(s: string, from: number, to: number): string {
	let prefix = ''
	let out = ''
	let col = 0
	let i = 0
	while (i < s.length && col < to) {
		let j = strings.skipEscape(s, i)
		if (j > i) {
			if (col < from) prefix += s.slice(i, j)
			else out += s.slice(i, j)
			i = j
			continue
		}
		let g = strings.glyphAt(s, i, col)
		let end = col + g.width
		if (col >= from && end <= to) out += s.slice(i, i + g.length)
		else if (end > from) out += ' '.repeat(Math.min(end, to) - Math.max(col, from))
		col = end
		i += g.length
	}
	return out ? prefix + out : ''
}

export const strings = { clean, charWidth, glyphAt, skipEscape, walk, visLen, expandTabs, containLinks, wordWrap, clipVisual, sliceVisual }
