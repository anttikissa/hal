// The notice stack in the terminal (task qm, common/notices.ts): drawn
// over the rows just above the tab bar, at the right, newest lowest;
// full width on a narrow terminal. Each notice is two rows behind a bar
// in its kind's colour: bold "tab name · what happened", then its line.

import { colors } from '../common/colors.ts'
import type { Folded } from '../common/notices.ts'
import { notices } from '../common/notices.ts'
import { strings } from '../common/strings.ts'
import { ansi } from './ansi.ts'
import { modalView } from './modal-view.ts'

// The stack's width on a terminal `cols` wide.
function width(cols: number): number {
	return cols < 72 ? cols : 44
}

function rows(stack: Folded, w: number): string[] {
	let c = colors.notice()
	let fill = (text: string, used: number) => text + ' '.repeat(Math.max(0, w - used - strings.visLen(text))) + ansi.UNCOLOR
	let out: string[] = []
	if (stack.more) out.push(ansi.sgr({ fg: c.fg!, bg: c.bg! }) + fill(strings.clipVisual('  ' + notices.moreText(stack.more), w), 0))
	for (let n of stack.shown) {
		let on = ansi.sgr({ fg: c[`${n.kind}Fg`]!, bg: c.bg! })
		let title = strings.clipVisual(ansi.clean(n.title), w - 2)
		out.push(on + '┃ ' + ansi.BOLD + title + ansi.UNBOLD + fill('', 2 + strings.visLen(title)))
		let line = strings.clipVisual(ansi.clean(n.line), w - 4)
		out.push(on + '┃   ' + ansi.sgr({ fg: c.fg! }) + fill(line, 4))
	}
	return out
}

// Draws `stack` over `lines`, its last row just above row `anchor`. A
// short frame grows at the top to hold it; returns the rows added.
function overlay(lines: string[], stack: Folded, anchor: number, cols: number): number {
	let w = noticeView.width(cols)
	let drawn = noticeView.rows(stack, w)
	let grow = Math.max(0, drawn.length - anchor)
	lines.unshift(...Array<string>(grow).fill(''))
	let top = anchor + grow - drawn.length
	drawn.forEach((r, i) => (lines[top + i] = modalView.overlay(lines[top + i]!, r, cols - w, w, cols)))
	return grow
}

export const noticeView = { width, rows, overlay }
