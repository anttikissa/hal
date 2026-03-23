// Terminal string utilities: visual width, word wrap, clipping.
// See docs/terminal.md rule 4: no line may exceed terminal width.

/** Split text into lines. Handles both 'foo\nbar\n' and 'foo\nbar' → ['foo', 'bar']. */
export function toLines(text: string): string[] {
	if (!text) return []
	return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}
/** Terminal display width of a Unicode code point. */
export function charWidth(cp: number): number {
	if (cp < 0x20) return 0
	if (cp < 0x7F) return 1
	// Zero-width: combining marks, ZWJ, variation selectors
	if ((cp >= 0x0300 && cp <= 0x036F) || (cp >= 0x1AB0 && cp <= 0x1AFF) ||
		(cp >= 0x1DC0 && cp <= 0x1DFF) || (cp >= 0x20D0 && cp <= 0x20FF) ||
		(cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xFE20 && cp <= 0xFE2F) ||
		cp === 0x200B || cp === 0x200C || cp === 0x200D ||
		cp === 0x2060 || cp === 0xFEFF || (cp >= 0xE0100 && cp <= 0xE01EF))
		return 0
	// East Asian Wide/Fullwidth + Emoji_Presentation characters
	if (isWide(cp)) return 2
	return 1
}

// Emoji_Presentation=Yes codepoints in BMP (Unicode 15.0, compacted)
const EMOJI_PRESENTATION = new Set([
	0x231A, 0x231B, 0x23E9, 0x23EA, 0x23EB, 0x23EC, 0x23ED, 0x23EE,
	0x23EF, 0x23F0, 0x23F1, 0x23F2, 0x23F3, 0x23F8, 0x23F9, 0x23FA,
	0x25AA, 0x25AB, 0x25B6, 0x25C0, 0x25FB, 0x25FC, 0x25FD, 0x25FE,
	0x2600, 0x2601, 0x2602, 0x2603, 0x2604, 0x260E, 0x2611, 0x2614,
	0x2615, 0x2618, 0x261D, 0x2620, 0x2622, 0x2623, 0x2626, 0x262A,
	0x262E, 0x262F, 0x2638, 0x2639, 0x263A, 0x2640, 0x2642, 0x2648,
	0x2649, 0x264A, 0x264B, 0x264C, 0x264D, 0x264E, 0x264F, 0x2650,
	0x2651, 0x2652, 0x2653, 0x265F, 0x2660, 0x2663, 0x2665, 0x2666,
	0x2668, 0x267B, 0x267E, 0x267F, 0x2692, 0x2693, 0x2694, 0x2695,
	0x2696, 0x2697, 0x2699, 0x269B, 0x269C, 0x26A0, 0x26A1, 0x26A7,
	0x26AA, 0x26AB, 0x26B0, 0x26B1, 0x26BD, 0x26BE, 0x26C4, 0x26C5,
	0x26C8, 0x26CE, 0x26CF, 0x26D1, 0x26D3, 0x26D4, 0x26E9, 0x26EA,
	0x26F0, 0x26F1, 0x26F2, 0x26F3, 0x26F4, 0x26F5, 0x26F7, 0x26F8,
	0x26F9, 0x26FA, 0x26FD, 0x2702, 0x2705, 0x2708, 0x2709, 0x270A,
	0x270B, 0x270C, 0x270D, 0x270F, 0x2712, 0x2714, 0x2716, 0x271D,
	0x2721, 0x2728, 0x2733, 0x2734, 0x2744, 0x2747, 0x274C, 0x274E,
	0x2753, 0x2754, 0x2755, 0x2757, 0x2763, 0x2764, 0x2795, 0x2796,
	0x2797, 0x27A1, 0x27B0, 0x27BF, 0x2934, 0x2935, 0x2B05, 0x2B06,
	0x2B07, 0x2B1B, 0x2B1C, 0x2B50, 0x2B55, 0x3030, 0x303D, 0x3297,
	0x3299,
])

function isWide(cp: number): boolean {
	if (EMOJI_PRESENTATION.has(cp)) return true
	return (
		(cp >= 0x1100 && cp <= 0x115F) ||
		(cp >= 0x2E80 && cp <= 0x303E) ||
		(cp >= 0x3041 && cp <= 0x4DBF) ||
		(cp >= 0x4E00 && cp <= 0x9FFF) ||
		(cp >= 0xA000 && cp <= 0xA4CF) ||
		(cp >= 0xA960 && cp <= 0xA97C) ||
		(cp >= 0xAC00 && cp <= 0xD7A3) ||
		(cp >= 0xF900 && cp <= 0xFAFF) ||
		(cp >= 0xFE10 && cp <= 0xFE6B) ||
		(cp >= 0xFF01 && cp <= 0xFF60) ||
		(cp >= 0xFFE0 && cp <= 0xFFE6) ||
		(cp >= 0x1F000 && cp <= 0x1FBFF) ||
		(cp >= 0x20000 && cp <= 0x3FFFF)
	)
}

/** Visible length of string (ignoring ANSI escapes, respecting wide chars). */
export function visLen(s: string): number {
	let n = 0, esc = false, osc = false
	for (const ch of s) {
		const cp = ch.codePointAt(0)!
		if (cp === 0x1B) { esc = true; continue }
		if (esc) {
			if (cp === 0x5D) { osc = true; esc = false; continue } // ESC ] = OSC
			if (cp === 0x6D) esc = false // ESC [ ... m = CSI
			continue
		}
		if (osc) { if (cp === 0x07) osc = false; continue } // BEL terminates OSC
		n += charWidth(cp)
	}
	return n
}

/** Word-wrap an ANSI string. Walks codepoints, skips escapes, breaks at word boundaries. */
export function wordWrap(text: string, width: number): string[] {
	if (width <= 0) return text.split('\n')
	const out: string[] = []
	for (const raw of text.split('\n')) {
		if (visLen(raw) <= width) { out.push(raw); continue }
		let vis = 0, wordStart = 0, lineStart = 0, esc = false
		for (let i = 0; i < raw.length;) {
			const cp = raw.codePointAt(i)!
			const cl = cp > 0xFFFF ? 2 : 1
			if (cp === 0x1B) { esc = true; i += cl; continue }
			if (esc) { if (cp === 0x6D) esc = false; i += cl; continue }
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
	let vis = 0, esc = false, osc = false, cut = 0
	for (let i = 0; i < s.length;) {
		const cp = s.codePointAt(i)!
		const cl = cp > 0xFFFF ? 2 : 1
		if (cp === 0x1B) { esc = true; i += cl; continue }
		if (esc) {
			if (cp === 0x5D) { osc = true; esc = false; i += cl; continue }
			if (cp === 0x6D) esc = false
			i += cl; continue
		}
		if (osc) { if (cp === 0x07) osc = false; i += cl; continue }
		const w = charWidth(cp)
		if (vis + w > max - 1) { cut = i; break }
		vis += w
		i += cl
	}
	return s.slice(0, cut) + '…'
}

export const strings = { charWidth, visLen, wordWrap, clipVisual }
