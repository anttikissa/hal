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
// (the prompt), tab-bar.ts (the tabs), help-row.ts (the last row) and
// modal-view.ts (modals over it all).

import { colors, type Style } from '../common/colors.ts'
import type { FormState } from '../common/forms.ts'
import { inbox } from '../common/inbox.ts'
import type { ModalState } from '../common/modals.ts'
import type { Item, Transcript } from '../common/transcript.ts'
import { ansi } from './ansi.ts'
import { formView } from './form-view.ts'
import { itemView } from './item-view.ts'
import { modalView } from './modal-view.ts'
import type { PromptState } from '../common/prompt.ts'
import type { Tab } from '../common/protocol.ts'
import { promptView } from './prompt-view.ts'
import type { HalCursor } from './hal-cursor.ts'
import { tabBar } from './tab-bar.ts'
import { helpRow } from './help-row.ts'
import { statusRow, type StatusInfo } from './status-row.ts'
import { strings } from '../common/strings.ts'

export interface View {
	transcript?: Transcript
	/** Where replayed history ends: a line there says it is old. */
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
	/** The host's tabs and the one shown: a tab bar row above the prompt;
	 * `lit` is the blink phase while an indicator blinks. */
	tabs?: { list: Tab[]; focused?: string; lit?: boolean }
	/** Tab completion's choices: listed in the help row. */
	choices?: string[]
	/** What the session is doing, centred in the prompt's top rule. */
	activity?: string
	/** The hint while the last prompt is edited: the help row shows it. */
	editing?: string
	/** The Hal cursor: after the streaming last item, or on its own row. */
	hal?: HalCursor
	/** The status row below the prompt box (task 1g); blank without. */
	status?: StatusInfo
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

// An item's painted rows on a terminal `cols` wide. An item with a
// block id shows it dim at the right of its first row, `#35`, an OSC 8
// link to the same block on the web (tasks wc, 0z); a gutter as wide
// as the id is kept free on every row, as the web keeps a column for
// it. `hal`: the item streams, so the Hal cursor follows its last
// character. Items never change in place (a change is a new item), so
// each is laid out once per width and look, not on every frame: a long
// history stays cheap to redraw. A kept row keeps the link code it was
// painted with (task e3 notes).
function itemRows(item: Item, cols: number, session?: string, hal?: HalCursor): string[] {
	let style = itemView.itemStyle(item)
	let key = `${cols} ${itemView.resultRows()} ${style ? ansi.sgr(style) : ''} ${session} ${item.key}`
	let kept = hal ? undefined : frame.state.rows.get(item)
	if (kept?.key === key) return kept.rows
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	let ref = itemView.ref(item, session)
	// On a very narrow terminal the text needs every column.
	if (ref && width < 4 * strings.visLen(ref.text)) ref = undefined
	let inner = ref ? Math.max(1, width - strings.visLen(ref.text) - 1) : width
	let lines = itemView.itemLines(item, inner)
	if (hal) lines = frame.withCursor(lines, hal, inner)
	if (ref && lines.length) {
		let gap = ' '.repeat(Math.max(1, width - strings.visLen(lines[0]!) - strings.visLen(ref.text)))
		// The glyph may have ended the item's colour: take it up again.
		let fg = style?.fg ? ansi.sgr({ fg: style.fg }) : ''
		lines[0] += `${gap}${fg}${ansi.DIM}\x1b]8;;${ansi.webUrl(ref.href)}\x07${ref.text}${ansi.LINK_OFF}${ansi.UNDIM}`
	}
	let rows = lines.map((r) => ansi.paint(r, style, cols))
	if (!hal) frame.state.rows.set(item, { key, rows })
	return rows
}

// The Hal cursor's block, or nothing in its dark phase.
function glyph(hal: HalCursor): string {
	if (!hal.lit) return ''
	let on = ansi.sgr({ fg: hal.color })
	return on + '█' + (on && ansi.UNCOLOR)
}

// Rows `width` wide with the Hal cursor after the last character, on
// a row of its own if that one is full.
function withCursor(rows: string[], hal: HalCursor, width: number): string[] {
	let last = rows.at(-1)
	if (last === undefined) return rows
	let g = frame.glyph(hal)
	if (strings.visLen(last) < width) return [...rows.slice(0, -1), last + g]
	return [...rows, g]
}

// The frame for `view` on a terminal of `rows` × `cols`. `full`: full
// mode, where blank rows after a short history put the chrome on the
// screen's last rows, so the prompt is always at the bottom
// (tasks/cc/terminal.md, Height management).
function build(view: View, cols: number, rows = 24, full = false): Frame {
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
	for (let i = 0; i < items.length; i++) {
		let item = items[i]!
		if (item.type === 'question' && view.form?.id === item.id) {
			let f = formView.formLines(view.form, width)
			block(f.rows, itemView.itemStyle(item))
			formCursor = { row: lines.length - f.rows.length + f.cursor.row, col: ansi.PAD.length + f.cursor.col }
		} else {
			let streams = i === items.length - 1 && view.hal?.at === 'stream'
			let rows = frame.itemRows(item, cols, view.transcript?.meta.id, streams ? view.hal : undefined)
			if (rows.length && (lines.length || above)) lines.push('')
			for (let r of rows) lines.push(r)
		}
	}
	// The transcript's tail: what is not in history yet, right after
	// it (never across the full-mode padding), where it will land. The
	// inbox first, each drawn as the prompt it will become: (steering)
	// > text; then prompts still on their way to the host, which join
	// the inbox or history at the same place, so nothing jumps.
	let t = view.transcript
	for (let m of t?.inbox ?? []) {
		// The tag takes at most half the row, so the text keeps room.
		let tag = strings.clipVisual(`(${inbox.tag(t!.state, m)})`, Math.max(1, Math.floor(width / 2))) + ' '
		let rows = promptView.mark(ansi.wrap(m.text, Math.max(1, width - strings.visLen(tag) - promptView.FIRST.length)))
		let pad = ' '.repeat(strings.visLen(tag))
		block(rows.map((r, i) => (i ? pad : ansi.DIM + tag + ansi.UNDIM) + r), colors.user())
	}
	for (let text of view.pending ?? []) {
		let rows = itemView.itemLines({ type: 'prompt', text }, width)
		rows.push(`${promptView.REST}${ansi.DIM}sending…${ansi.UNDIM}`)
		block(rows, colors.user())
	}
	// The idle Hal cursor: a blank row, its row, and the blank row that
	// comes before the chrome. A question being answered has the cursor.
	if (view.hal?.at === 'idle' && !formCursor) {
		if (lines.length || above) lines.push('')
		lines.push(ansi.PAD + frame.glyph(view.hal))
	}
	// The chrome, built apart to know its height for the padding.
	let history = lines
	lines = []
	above = history.length > 0 || full
	if (view.notice) block(ansi.wrap(view.notice, width), { fg: colors.log().fg! })
	// Below them, the chrome proper: tab bar, the prompt box between
	// two rules, then the help row. Its height depends only on the
	// prompt's rows, so nothing below the transcript jumps.
	let p = promptView.box(view.prompt, width, view.placeholder)
	let input = colors.input()
	let rule = (left: string, center = '') => ansi.sgr(input) + promptView.rule(cols, left, ansi.clean(center)) + ansi.UNCOLOR
	if (lines.length || above) lines.push('')
	if (view.tabs?.list.length) lines.push(tabBar.row(view.tabs.list, view.tabs.focused, cols, view.tabs.lit ?? true))
	lines.push(rule(p.above ? `↑${p.above}` : '', view.activity))
	let top = lines.length
	for (let r of p.rows) lines.push(ansi.paint(r, input, cols))
	lines.push(rule(p.below ? `↓${p.below}` : ''))
	lines.push(view.status ? statusRow.row(view.status, cols) : '')
	lines.push(helpRow.row(view, cols))
	let pad = full ? Math.max(0, rows - lines.length - history.length) : 0
	let chrome = lines
	lines = [...history, ...Array<string>(pad).fill(''), ...chrome]
	top += history.length + pad
	let cursor = formCursor ?? { row: top + p.row, col: ansi.PAD.length + p.col }
	let out = { lines, cursor, promptScroll: p.scroll, history: history.length }
	if (!view.modal) return out
	let m = modalView.withModal(lines, view.modal, rows, cols)
	return { ...out, cursor: m.cursor, modalScroll: m.scroll }
}

export const frame = { state: { rows: new WeakMap<Item, { key: string; rows: string[] }>() }, build, itemRows, glyph, withCursor, promptWidth }
