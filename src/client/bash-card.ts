// The short Bash card's command in the terminal (task hyt): in the
// output's color, after the title when it fits, else on its own rows.
// A one-line command too long for its room scrolls once from its start
// to its end as its call appears live; a multi-line one shows its first
// and last lines joined by ↵. Pure.

import { colors, type Style } from '../common/colors.ts'
import { strings } from '../common/strings.ts'
import { ansi } from './ansi.ts'

// Columns per second a long command scrolls.
const SPEED = 200
const GAP = '   '
// Columns kept for the title row's status, so where the command goes is
// the same while the call runs and after it ends (task 4y4).
const STATUS = 16
// The narrowest room worth a command after the title.
const MIN = 12

const commandLines = (command: string): string[] => command.replace(/\s+$/, '').split('\n').map((l) => strings.expandTabs(ansi.clean(l)))

// `text` in the output color of a card in `style`; ↵ keeps the card's.
function paint(text: string, style: Style | undefined): string {
	if (ansi.mono() || !style?.fg) return text
	let on = ansi.sgr({ fg: colors.toolOutput(style.fg) }), off = ansi.sgr({ fg: style.fg })
	return text.split(/(↵)/).map((p) => (p === '↵' || !p ? p : on + p + off)).join('')
}

// `line`'s visible columns [at, at + room), with … where it goes on.
function window(line: string, room: number, at: number): string {
	let len = strings.visLen(line)
	if (len <= room) return line
	if (room < 3) return strings.clipVisual(line, room)
	let start = at > 0 ? '…' : '', end = at + room < len ? '…' : ''
	return start + strings.sliceVisual(line, at + start.length, at + room - end.length) + end
}

// `line` in `room` columns: its start and end around a … in the middle.
function middle(line: string, room: number): string {
	let len = strings.visLen(line)
	if (len <= room) return line
	if (room < 5) return strings.clipVisual(line, room)
	let head = Math.ceil((room - 1) / 2)
	return strings.sliceVisual(line, 0, head) + '…' + strings.sliceVisual(line, len - (room - 1 - head), len)
}

// A one-line command `ms` after its call appeared: its start, moving to
// its end at SPEED.
function scrolled(line: string, room: number, ms: number): string {
	let len = strings.visLen(line)
	return window(line, room, Math.max(0, Math.min(len - room, Math.floor((ms * SPEED) / 1000))))
}

// A multi-line command on one row: first ↵ … ↵ last, the first line cut
// in its middle before the last is cut.
function joined(lines: string[], room: number): string {
	let first = lines[0]!, last = lines.at(-1)!.trim()
	let sep = lines.length > 2 ? ' ↵ … ↵ ' : ' ↵ '
	let rest = room - sep.length
	if (rest < 4) return strings.clipVisual(first, room)
	let lastRoom = Math.min(strings.visLen(last), Math.max(Math.floor(rest / 2), rest - strings.visLen(first)))
	return middle(first, rest - lastRoom) + sep + window(last, lastRoom, Math.max(0, strings.visLen(last) - lastRoom))
}

// The rows a short Bash card shows before its output, `rows` in all:
// the title row `head` (with the command after it when it fits) and the
// command's own rows. `width`: the card's; `hw`: what the title row
// leaves after its status; `ms`: since the call appeared.
function head(head: string, command: unknown, width: number, hw: number, rows: number, ms: number, style: Style | undefined): string[] {
	if (typeof command !== 'string' || !command.trim()) return [head]
	let lines = commandLines(command)
	let fits = lines.length === 1 && strings.visLen(lines[0]!) <= width - strings.visLen(head) - GAP.length - STATUS
	if (fits || rows < 3) {
		let room = hw - strings.visLen(head) - GAP.length
		if (room < MIN && !(fits && strings.visLen(lines[0]!) <= room)) return [head]
		let text = lines.length === 1 ? scrolled(lines[0]!, room, ms) : joined(lines, room)
		return [head + GAP + paint(text, style)]
	}
	if (lines.length === 1) return [head, paint(scrolled(lines[0]!, width, ms), style)]
	if (rows < 6) return [head, paint(joined(lines, width), style)]
	let last = lines.at(-1)!
	return [head, paint(middle(lines[0]!, width - 2) + ' ↵', style), paint(lines.length > 2 ? middle(`… ↵ ${last}`, width) : middle(last, width), style)]
}

// Whether `command` may still be scrolling `ms` after its call appeared.
const scrolling = (command: unknown, ms: number): boolean => typeof command === 'string' && ms >= 0 && ms < (strings.visLen(command) * 1000) / SPEED && !command.trim().includes('\n')

export const bashCard = { head, scrolling }
