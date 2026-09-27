// The frame: every row the terminal should show, from the first
// transcript item to the prompt, and where the cursor goes. Pure; the
// renderer (render.ts) decides how to get it onto the terminal.
//
// All history is always in the frame, never a viewport-sized slice
// (tasks/cc/terminal.md rule 3). Every row fits the terminal width, has
// its tabs expanded, and carries no control characters from the text
// it shows.
//
// Its parts are drawn by ansi.ts (escapes, painted rows), item-view.ts
// (transcript items), form-view.ts (open questions), prompt-view.ts
// (the prompt) and modal-view.ts (modals over it all).

import { colors, type Style } from '../common/colors.ts'
import type { FormState } from '../common/forms.ts'
import { inbox } from '../common/inbox.ts'
import type { ModalState } from '../common/modals.ts'
import { transcript, type Resumed, type Transcript } from '../common/transcript.ts'
import { ansi } from './ansi.ts'
import { formView } from './form-view.ts'
import { itemView } from './item-view.ts'
import { modalView } from './modal-view.ts'
import type { PromptState } from '../common/prompt.ts'
import { promptView } from './prompt-view.ts'

export interface View {
	transcript?: Transcript
	/** Where replayed history ends: a line there says it is old. */
	resumed?: Resumed
	prompt: PromptState
	/** Prompts sent but not yet acknowledged by the host. */
	pending?: string[]
	/** A passing message for the user, such as a refused command. */
	notice?: string
	/** The open question being answered here: keys and cursor go to it. */
	form?: FormState
	/** A dim example request shown while the prompt is empty. */
	placeholder?: string
	/** A modal drawn over everything: keys and cursor go to it. */
	modal?: ModalState
}

export interface Frame {
	lines: string[]
	/** Where the terminal cursor belongs; row into lines, 0-based column. */
	cursor: { row: number; col: number }
	/** The first list row the modal shows, to keep as its scroll. */
	modalScroll?: number
	/** The prompt box's first visible row, to keep as its scroll. */
	promptScroll: number
}

// The prompt's content width on a terminal `cols` wide: what Up/Down
// move through.
function promptWidth(cols: number): number {
	return Math.max(1, Math.max(1, cols - 2 * ansi.PAD.length) - promptView.FIRST.length)
}

// The frame for `view` on a terminal of `rows` × `cols`.
function build(view: View, cols: number, rows = 24): Frame {
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	let lines: string[] = []
	let block = (rows: string[], style: Style | undefined) => {
		if (!rows.length) return
		if (lines.length) lines.push('')
		for (let r of rows) lines.push(ansi.paint(r, style, cols))
	}
	let items = view.transcript?.items ?? []
	let formCursor: Frame['cursor'] | undefined
	for (let i = 0; i <= items.length; i++) {
		if (i === view.resumed?.at) block(ansi.wrap(transcript.resumedLabel(view.resumed), width), { fg: colors.log().fg! })
		if (i >= items.length) continue
		let item = items[i]!
		if (item.type === 'question' && view.form?.id === item.id) {
			let f = formView.formLines(view.form, width)
			block(f.rows, itemView.itemStyle(item))
			formCursor = { row: lines.length - f.rows.length + f.cursor.row, col: ansi.PAD.length + f.cursor.col }
		} else block(itemView.itemLines(item, width), itemView.itemStyle(item))
	}
	for (let text of view.pending ?? []) {
		let rows = itemView.itemLines({ type: 'prompt', text }, width)
		rows.push(`${promptView.REST}${ansi.DIM}sending…${ansi.UNDIM}`)
		block(rows, colors.user())
	}
	// The inbox, always in view above the prompt.
	let t = view.transcript
	for (let m of t?.inbox ?? []) block(ansi.wrap(`${inbox.label(t!.state, m)}: ${m.text}`, width), { fg: colors.log().fg! })
	if (view.notice) block(ansi.wrap(view.notice, width), { fg: colors.log().fg! })
	let p = promptView.box(view.prompt, width, view.placeholder)
	let log = { fg: colors.log().fg! }
	if (p.above) lines.push(ansi.paint(p.above, log, cols))
	else if (lines.length) lines.push('')
	let top = lines.length
	let input = colors.input()
	for (let r of p.rows) lines.push(ansi.paint(r, input, cols))
	if (p.below) lines.push(ansi.paint(p.below, log, cols))
	let cursor = formCursor ?? { row: top + p.row, col: ansi.PAD.length + p.col }
	if (!view.modal) return { lines, cursor, promptScroll: p.scroll }
	let m = modalView.withModal(lines, view.modal, rows, cols)
	return { lines, cursor: m.cursor, modalScroll: m.scroll, promptScroll: p.scroll }
}

export const frame = { build, promptWidth }
