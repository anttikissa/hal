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
// (the prompt), tab-bar.ts (the tabs) and modal-view.ts (modals over
// it all).

import { colors, type Style } from '../common/colors.ts'
import type { FormState } from '../common/forms.ts'
import { inbox } from '../common/inbox.ts'
import type { ModalState } from '../common/modals.ts'
import { transcript, type Shown as Item, type Resumed, type Transcript } from '../common/transcript.ts'
import { ansi } from './ansi.ts'
import { formView } from './form-view.ts'
import { itemView } from './item-view.ts'
import { modalView } from './modal-view.ts'
import type { PromptState } from '../common/prompt.ts'
import type { Tab } from '../common/protocol.ts'
import { promptView } from './prompt-view.ts'
import { tabBar } from './tab-bar.ts'
import { strings } from '../common/strings.ts'

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
	/** The host's tabs and the one shown: a tab bar row above the prompt. */
	tabs?: { list: Tab[]; focused?: string }
	/** Tab completion's choices: a list below the prompt. */
	choices?: string[]
}

export interface Frame {
	lines: string[]
	/** Where the terminal cursor belongs; row into lines, 0-based column. */
	cursor: { row: number; col: number }
	/** The first list row the modal shows, to keep as its scroll. */
	modalScroll?: number
	/** The prompt box's first visible row, to keep as its scroll. */
	promptScroll: number
	/** Rows of history (transcript and pending prompts) at the top. */
	history: number
}

// The prompt's content width on a terminal `cols` wide: what Up/Down
// move through.
function promptWidth(cols: number): number {
	return Math.max(1, Math.max(1, cols - 2 * ansi.PAD.length) - promptView.FIRST.length)
}

// An item's painted rows on a terminal `cols` wide. Items never change
// in place (a change is a new item), so each is laid out once per width
// and look, not on every frame: a long history stays cheap to redraw.
function itemRows(item: Item, cols: number): string[] {
	let style = itemView.itemStyle(item)
	let key = `${cols} ${itemView.resultRows()} ${style ? ansi.sgr(style) : ''}`
	let kept = frame.state.rows.get(item)
	if (kept?.key === key) return kept.rows
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	let rows = itemView.itemLines(item, width).map((r) => ansi.paint(r, style, cols))
	frame.state.rows.set(item, { key, rows })
	return rows
}

// The frame for `view` on a terminal of `rows` × `cols`. Blank rows after
// the history lift it to `peak` rows (as far as the screen allows), so
// the prompt stays on one row between tabs (tasks/cc/terminal.md, Height
// management).
function build(view: View, cols: number, rows = 24, peak = 0): Frame {
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	let lines: string[] = []
	// Whether something is above `lines` (the history, above the chrome).
	let above = false
	let block = (rows: string[], style: Style | undefined) => {
		if (!rows.length) return
		if (lines.length || above) lines.push('')
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
		} else {
			let rows = frame.itemRows(item, cols)
			if (rows.length && (lines.length || above)) lines.push('')
			for (let r of rows) lines.push(r)
		}
	}
	for (let text of view.pending ?? []) {
		let rows = itemView.itemLines({ type: 'prompt', text }, width)
		rows.push(`${promptView.REST}${ansi.DIM}sending…${ansi.UNDIM}`)
		block(rows, colors.user())
	}
	// The chrome, built apart to know its height for the padding.
	let history = lines
	lines = []
	above = history.length > 0 || peak > 0
	// The inbox, always in view above the prompt.
	let t = view.transcript
	// Each drawn as the prompt it will become: (steering) > text.
	for (let m of t?.inbox ?? []) {
		let tag = `(${inbox.tag(t!.state, m)}) `
		let rows = promptView.mark(ansi.wrap(m.text, Math.max(1, width - tag.length - promptView.FIRST.length)))
		let pad = ' '.repeat(strings.visLen(tag))
		block(rows.map((r, i) => (i ? pad : ansi.DIM + tag + ansi.UNDIM) + r), colors.user())
	}
	if (view.notice) block(ansi.wrap(view.notice, width), { fg: colors.log().fg! })
	let p = promptView.box(view.prompt, width, view.placeholder)
	let log = { fg: colors.log().fg! }
	let bar = !!view.tabs?.list.length
	if ((lines.length || above) && (bar || !p.above)) lines.push('')
	if (bar) lines.push(tabBar.row(view.tabs!.list, view.tabs!.focused, cols))
	if (p.above) lines.push(ansi.paint(p.above, log, cols))
	let top = lines.length
	let input = colors.input()
	for (let r of p.rows) lines.push(ansi.paint(r, input, cols))
	if (p.below) lines.push(ansi.paint(p.below, log, cols))
	for (let r of view.choices ? ansi.wrap(view.choices.join('  '), width) : []) lines.push(ansi.paint(r, log, cols))
	let pad = Math.max(0, Math.min(peak, rows - lines.length) - history.length)
	let chrome = lines
	lines = [...history, ...Array<string>(pad).fill(''), ...chrome]
	top += history.length + pad
	let cursor = formCursor ?? { row: top + p.row, col: ansi.PAD.length + p.col }
	let out = { lines, cursor, promptScroll: p.scroll, history: history.length }
	if (!view.modal) return out
	let m = modalView.withModal(lines, view.modal, rows, cols)
	return { ...out, cursor: m.cursor, modalScroll: m.scroll }
}

export const frame = { state: { rows: new WeakMap<Item, { key: string; rows: string[] }>() }, build, itemRows, promptWidth }
