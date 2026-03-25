// Terminal string utilities: visual width, word wrap, clipping.
// See docs/terminal.md rule 4: no line may exceed terminal width.

/** Split text into lines. Handles both 'foo\nbar\n' and 'foo\nbar' → ['foo', 'bar']. */
export function toLines(text: string): string[] {
	if (!text) return []
	return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

/**
 * Expand tab characters to spaces. Tabs are position-dependent: each tab
 * advances to the next multiple of `tabWidth` columns. We walk the string
 * tracking column position so tabs in the middle of a line expand correctly.
 *
 * This MUST be called before visLen/wordWrap/clipVisual on any string that
 * might contain tabs. charWidth() returns 0 for tabs (since their width
 * depends on position), so visLen undercounts, bgLine overpads, and the
 * resulting line wraps to a second physical row — causing the "double lines"
 * rendering bug.
 */
export function expandTabs(s: string, tabWidth = 4): string {
	if (!s.includes('\t')) return s
	let out = ''
	let col = 0
	for (const ch of s) {
		if (ch === '\t') {
			// Advance to next tab stop: at least 1 space, up to tabWidth
			const spaces = tabWidth - (col % tabWidth)
			out += ' '.repeat(spaces)
			col += spaces
		} else if (ch === '\n') {
			out += ch
			col = 0
		} else {
			out += ch
			// ANSI escapes don't advance the column, but for tab expansion
			// purposes this approximation is fine — tabs in ANSI sequences
			// are vanishingly rare and the worst case is slightly too much padding.
			col++
		}
	}
	return out
}
/** Terminal display width of a Unicode code point. */
export function charWidth(cp: number): number {
	if (cp < 0x20) return 0
	if (cp < 0x7f) return 1
	// Style markers (PUA U+E000–E005): zero width, resolved to ANSI later
	if (cp >= 0xe000 && cp <= 0xe005) return 0
	// Zero-width: combining marks, ZWJ, variation selectors
	if (
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
		return 0
	// East Asian Wide/Fullwidth + Emoji_Presentation characters
	if (isWide(cp)) return 2
	return 1
}

// Emoji_Presentation=Yes codepoints in BMP (Unicode 15.0, compacted)
const EMOJI_PRESENTATION = new Set([
	0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23ed, 0x23ee, 0x23ef, 0x23f0, 0x23f1, 0x23f2, 0x23f3, 0x23f8,
	0x23f9, 0x23fa, 0x25aa, 0x25ab, 0x25b6, 0x25c0, 0x25fb, 0x25fc, 0x25fd, 0x25fe, 0x2600, 0x2601, 0x2602, 0x2603,
	0x2604, 0x260e, 0x2611, 0x2614, 0x2615, 0x2618, 0x261d, 0x2620, 0x2622, 0x2623, 0x2626, 0x262a, 0x262e, 0x262f,
	0x2638, 0x2639, 0x263a, 0x2640, 0x2642, 0x2648, 0x2649, 0x264a, 0x264b, 0x264c, 0x264d, 0x264e, 0x264f, 0x2650,
	0x2651, 0x2652, 0x2653, 0x265f, 0x2660, 0x2663, 0x2665, 0x2666, 0x2668, 0x267b, 0x267e, 0x267f, 0x2692, 0x2693,
	0x2694, 0x2695, 0x2696, 0x2697, 0x2699, 0x269b, 0x269c, 0x26a0, 0x26a1, 0x26a7, 0x26aa, 0x26ab, 0x26b0, 0x26b1,
	0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26c8, 0x26ce, 0x26cf, 0x26d1, 0x26d3, 0x26d4, 0x26e9, 0x26ea, 0x26f0, 0x26f1,
	0x26f2, 0x26f3, 0x26f4, 0x26f5, 0x26f7, 0x26f8, 0x26f9, 0x26fa, 0x26fd, 0x2702, 0x2705, 0x2708, 0x2709, 0x270a,
	0x270b, 0x270c, 0x270d, 0x270f, 0x2712, 0x2714, 0x2716, 0x271d, 0x2721, 0x2728, 0x2733, 0x2734, 0x2744, 0x2747,
	0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2763, 0x2764, 0x2795, 0x2796, 0x2797, 0x27a1, 0x27b0, 0x27bf,
	0x2934, 0x2935, 0x2b05, 0x2b06, 0x2b07, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55, 0x3030, 0x303d, 0x3297, 0x3299,
])

function isWide(cp: number): boolean {
	if (EMOJI_PRESENTATION.has(cp)) return true
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

/** Visible length of string (ignoring ANSI escapes, respecting wide chars). */
export function visLen(s: string): number {
	let n = 0,
		esc = false,
		osc = false
	for (const ch of s) {
		const cp = ch.codePointAt(0)!
		if (cp === 0x1b) {
			esc = true
			continue
		}
		if (esc) {
			if (cp === 0x5d) {
				osc = true
				esc = false
				continue
			} // ESC ] = OSC
			if (cp === 0x6d) esc = false // ESC [ ... m = CSI
			continue
		}
		if (osc) {
			if (cp === 0x07) osc = false
			continue
		} // BEL terminates OSC
		n += charWidth(cp)
	}
	return n
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
			esc = false
		for (let i = 0; i < raw.length; ) {
			const cp = raw.codePointAt(i)!
			const cl = cp > 0xffff ? 2 : 1
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
			vis += charWidth(cp)
			if (vis > width) {
				const at = wordStart > lineStart ? wordStart : i
				out.push(raw.slice(lineStart, at))
				lineStart = raw[at] === ' ' ? at + 1 : at
				wordStart = lineStart
				vis = visLen(raw.slice(lineStart, i + cl))
			}
			i += cl
		}
		if (lineStart < raw.length) out.push(raw.slice(lineStart))
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
		const cl = cp > 0xffff ? 2 : 1
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
		const w = charWidth(cp)
		if (vis + w > max - 1) {
			cut = i
			break
		}
		vis += w
		i += cl
	}
	return s.slice(0, cut) + '…'
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
export const M_DIM = '\uE004'
export const M_DIM_OFF = '\uE005'

const MARKER_ANSI: Record<string, string> = {
	[M_BOLD]: '\x1b[1m',
	[M_BOLD_OFF]: '\x1b[22m',
	[M_ITALIC]: '\x1b[3m',
	[M_ITALIC_OFF]: '\x1b[23m',
	[M_DIM]: '\x1b[2m',
	[M_DIM_OFF]: '\x1b[22m',
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

export const strings = { charWidth, visLen, wordWrap, clipVisual, resolveMarkers, expandTabs }
