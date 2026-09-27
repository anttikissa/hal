// Escape codes and row primitives the frame is built from: styles to
// SGR, padded and painted rows, and text made safe to show. Pure.

import type { Style } from '../common/colors.ts'
import { oklch } from '../common/oklch.ts'
import { strings } from '../common/strings.ts'

// The escape that switches to a style's fg and bg (truecolor); none
// in a monochrome terminal.
function sgr(style: Style): string {
	if (ansi.mono()) return ''
	let parts: string[] = []
	if (style.fg) parts.push(`38;2;${oklch.toRgb(style.fg).join(';')}`)
	if (style.bg) parts.push(`48;2;${oklch.toRgb(style.bg).join(';')}`)
	return parts.length ? `\x1b[${parts.join(';')}m` : ''
}

// A padded row in a style. With a background it is a card filling all
// `cols` columns; colour always ends with the row.
function paint(row: string, style: Style | undefined, cols: number): string {
	let on = style ? ansi.sgr(style) : ''
	if (!on) return ansi.PAD + row
	let fill = style!.bg ? ' '.repeat(Math.max(0, cols - ansi.PAD.length - strings.visLen(row))) : ''
	return on + ansi.PAD + row + fill + ansi.UNCOLOR
}

function wrap(text: string, width: number): string[] {
	return strings.wordWrap(strings.expandTabs(ansi.clean(text.replace(/\r\n?/g, '\n'))), width)
}

export const ansi = {
	// One blank column on each side of every row.
	PAD: ' ',
	DIM: '\x1b[2m',
	UNDIM: '\x1b[22m',
	INVERSE: '\x1b[7m',
	UNINVERSE: '\x1b[27m',
	UNCOLOR: '\x1b[39;49m',
	RESET: '\x1b[0m',
	LINK_OFF: '\x1b]8;;\x07',
	// GNU screen (STY set, or a TERM of screen*) mangles truecolor, so
	// there the terminal is monochrome: no colour escapes at all, only
	// bold, dim and reverse video. Read on every call.
	mono: (): boolean => !!process.env.STY || (process.env.TERM ?? '').startsWith('screen'),
	sgr,
	paint,
	clean: (s: string): string => strings.clean(s),
	wrap,
}
