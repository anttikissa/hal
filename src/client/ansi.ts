// Escape codes and row primitives the frame is built from: styles to
// SGR, padded and painted rows, links, and text made safe to show.

import { attachments } from '../common/attachments.ts'
import { colors, type Style } from '../common/colors.ts'
import { oklch } from '../common/oklch.ts'
import { settings } from '../common/settings.ts'
import { strings } from '../common/strings.ts'
import { uploads } from '../common/uploads.ts'

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

// Text wrapped to `width`; a word wider than that keeps a row of its
// own, which paintRows lets the terminal soft-wrap. Glimpses that count
// rows (tool output) pass `keepLong` false: they break it.
function wrap(text: string, width: number, keepLong = true): string[] {
	return strings.wordWrap(strings.expandTabs(ansi.clean(text.replace(/\r\n?/g, '\n'))), width, keepLong)
}

// A row painted as terminal rows. One wider than the terminal (a long
// word, such as a URL) flows on: its first terminal row starts at the
// pad, the rest at column 0, and every row but the last ends with FLOW
// (nothing else pads them), so the renderer writes them in one go and
// the terminal soft-wraps them into one line: a URL there opens and
// copies whole. Colour ends only after the last one.
function paintRows(row: string, style: Style | undefined, cols: number): string[] {
	let full = ansi.PAD + row
	if (strings.visLen(full) <= cols) return [ansi.paint(row, style, cols)]
	let on = style ? ansi.sgr(style) : ''
	let out: string[] = []
	let start = 0
	let used = 0
	strings.walk(full, 0, (i, w) => {
		if (used + w > cols) {
			out.push(full.slice(start, i))
			start = i
			used = 0
		}
		used += w
	})
	let fill = on && style!.bg ? ' '.repeat(cols - used) : ''
	let rows = out.map((r) => on + r + ansi.FLOW)
	rows.push(on + full.slice(start) + fill + (on && ansi.UNCOLOR))
	return rows
}

// A row with each whole [image/<name>] or [paste/<name>] marker made an
// OSC 8 link to its page on the host's web endpoint (tasks qy, 31); a
// marker still uploading is quieter (ansi.quiet) and not yet a link. Each link closes in
// the row it opens in; the visible text is unchanged.
function links(row: string): string {
	return row.replace(attachments.fileMarker, (m, path: string) =>
		uploads.inFlight(m) ? ansi.quiet(m, colors.user()) : `\x1b]8;;${ansi.webUrl(`/${path}`)}\x07${m}${ansi.LINK_OFF}`,
	)
}

// The hidden target of a link to `path` on the host's web address: it
// carries the link code, so a click logs a browser in (task e3). Never
// visible text. The code goes before a #fragment, so the fragment
// (a block id, task wc) still reaches the page.
function webUrl(path: string): string {
	let { url, code } = ansi.state.web
	let [page, hash] = path.split(/(?=#)/)
	return `${url || settings.webUrl()}${page}${code ? `?auth=${code}` : ''}${hash ?? ''}`
}

// `text` in the quieter colour of `style` (oklch.quiet), then back to
// the style's own fg; plain in a monochrome terminal. Never SGR 2.
function quiet(text: string, style: Style | undefined): string {
	if (ansi.mono() || !text) return text
	let fg = style?.fg ?? colors.log().fg!
	let back = style?.fg ? ansi.sgr({ fg: style.fg }) : '\x1b[39m'
	return ansi.sgr({ fg: colors.quiet(fg, style?.bg ?? colors.screen()) }) + text + back
}

export const ansi = {
	// The host's web address and this client's link code, from its
	// latest `auth` event (task e3); empty until one came.
	state: { web: { url: '', code: '' } },
	// One blank column on each side of every row.
	PAD: ' ',
	BOLD: '\x1b[1m',
	UNBOLD: '\x1b[22m',
	INVERSE: '\x1b[7m',
	UNINVERSE: '\x1b[27m',
	UNCOLOR: '\x1b[39;49m',
	RESET: '\x1b[0m',
	LINK_OFF: '\x1b]8;;\x07',
	// Ends a terminal row that the next one continues (paintRows): an
	// APC the renderer strips, zero columns wide.
	FLOW: '\x1b_flow\x1b\\',
	// GNU screen (STY set, or a TERM of screen*) mangles truecolor, so
	// there the terminal is monochrome: no colour escapes at all, only
	// bold and reverse video. Read on every call.
	mono: (): boolean => !!process.env.STY || (process.env.TERM ?? '').startsWith('screen'),
	sgr,
	quiet,
	paint,
	paintRows,
	clean: (s: string): string => strings.clean(s),
	wrap,
	links,
	webUrl,
}
