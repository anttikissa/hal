// The frame: every row the terminal should show, from the first
// transcript item to the prompt, and where the cursor goes. Pure; the
// renderer (render.ts) decides how to get it onto the terminal.
//
// All history is always in the frame, never a viewport-sized slice
// (tasks/cc/terminal.md rule 3). Every row fits the terminal width (a
// wider one flows on over rows ending in ansi.FLOW), has
// its tabs expanded, and carries no control characters from the text
// it shows.
//
// Its parts are drawn by ansi.ts (escapes, painted rows), item-view.ts
// (transcript items), form-view.ts (open questions), prompt-view.ts
// (the prompt), tab-bar.ts (the tabs), help-row.ts (the last row) and
// modal-view.ts (modals over it all).

import { colors, type Style } from '../common/colors.ts'
import type { FormState } from '../common/forms.ts'
import type { ModalState } from '../common/modals.ts'
import { inbox } from '../common/inbox.ts'
import { transcript, type Item, type Transcript } from '../common/transcript.ts'
import { ansi } from './ansi.ts'
import { formView } from './form-view.ts'
import { itemView } from './item-view.ts'
import { modalView } from './modal-view.ts'
import { noticeView } from './notice-view.ts'
import type { Folded } from '../common/notices.ts'
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
	target?: string
	/** Where replayed history ends: a line there says it is old. */
	prompt: PromptState
	/** Prompts sent but not yet acknowledged by the host. */
	pending?: string[]
	/** Why the tab stopped (an error, a block, a pause reason): its state. */
	why?: string
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
	/** A new commit is checked out: the help row offers ctrl-r. */
	newCode?: boolean
	/** The notice stack, over the rows just above the tab bar (task qm). */
	notices?: Folded
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
	return Math.max(1, cols - 2 * ansi.PAD.length)
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
function itemRows(item: Item, cols: number, session?: string, hal?: HalCursor, calls?: Map<string, string>, attached = false): string[] {
	let style = itemView.itemStyle(item)
	// The web address is in every item's link: a server that bound after
	// the first paint (another port) must reach rows laid out before it.
	let key = `${cols} ${itemView.resultRows()} ${style ? ansi.sgr(style) : ''} ${session} ${item.key} ${item.type === 'tool-result' ? `${calls?.get(item.id) ?? ''}${attached ? '^' : ''}` : ''} ${ansi.state.web.url}`
	let kept = hal ? undefined : frame.state.rows.get(item)
	if (kept?.key === key) return kept.rows
	let { inner, mark } = frame.ref(item, cols, session, style)
	let lines = itemView.itemLines(item, inner, !!hal, session, calls, attached)
	if (hal) lines = frame.withCursor(lines, hal, inner)
	// A block with a background has a row of it above and below its
	// text, as the old Hal drew prompt cards; the id goes below the top.
	let padded = !!style?.bg && lines.length > 0
	if (padded) lines = ['', ...lines, '']
	mark(lines, padded ? 1 : 0)
	let rows = lines.flatMap((r) => ansi.paintRows(r, style, cols))
	if (!hal) frame.state.rows.set(item, { key, rows })
	return rows
}

// The text width beside an item's id, and how to put the id on row `at`.
function ref(item: Item, cols: number, session: string | undefined, style: Style | undefined): { inner: number; mark: (lines: string[], at: number) => void } {
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	let ref = itemView.ref(item, session)
	// On a very narrow terminal the text needs every column.
	if (ref && width < 4 * strings.visLen(ref.text)) ref = undefined
	let inner = ref ? Math.max(1, width - strings.visLen(ref.text) - 1) : width
	let mark = (lines: string[], at: number) => {
		if (!ref || lines.length <= at) return
		let gap = ' '.repeat(Math.max(1, width - strings.visLen(lines[at]!) - strings.visLen(ref.text)))
		lines[at] += gap + ansi.quiet(`\x1b]8;;${ansi.webUrl(ref.href)}\x07${ref.text}${ansi.LINK_OFF}`, style)
	}
	return { inner, mark }
}

// A queued message's compact row (task 16): `note`, then its text, no
// header; at most 3 rows, then how many more. Its id links to the web,
// where it opens in full.
function queuedRows(item: Item & { type: 'prompt' }, note: string, cols: number, session?: string): string[] {
	let style = itemView.itemStyle(item)
	let { inner, mark } = frame.ref(item, cols, session, style)
	let lines = ansi.wrap(`${note} ${item.text}`, inner)
	if (lines.length > 3) lines = [...lines.slice(0, 3), `… ${lines.length - 3} more lines`]
	mark(lines, 0)
	return lines.flatMap((r) => ansi.paintRows(r, style, cols))
}

// A streaming block never shrinks (task fn): the tallest it was drawn
// at, from its first render here, pads it with blank rows at its end,
// also after it stops streaming, until the next full redraw (render.draw
// forgets them all). In memory only, per block and width.
function highWater(rows: string[], item: Item, cols: number, session: string | undefined, streams: boolean): string[] {
	let id = `${cols} ${session} ${item.key}`
	let peaks = frame.state.peaks
	let peak = peaks.get(id)
	if (peak === undefined && !streams) return rows
	if (rows.length >= (peak ?? 0)) {
		peaks.set(id, rows.length)
		return rows
	}
	return [...rows, ...Array<string>(peak! - rows.length).fill(ansi.paint('', itemView.itemStyle(item), cols))]
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

// The rows of the transcript's items, and where a question being
// answered among them puts the cursor.
export type Past = { lines: string[]; formCursor?: Frame['cursor']; target?: number }

// Lays out the transcript's items. The rows of items drawn last time
// and unchanged since are reused as they are: a frame costs what
// changed, not the whole history. With a `deadline`, stops at the first
// stable item once it is past (after laying out at least one) and
// returns nothing; what was laid out is kept (unless `save` is false),
// so the next call goes on from there: a long history is laid out in
// slices (task 7j).
function layout(view: View, cols: number, deadline = Infinity, save = true): Past | undefined {
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	let items = view.transcript?.items ?? []
	let session = view.transcript?.meta.id
	let calls = new Map<string, string>()
	// Keep the recorded result inspectable via the call's block link, but
	// don't paint it twice when a command already said the same outcome.
	let commands = new Set(items.flatMap((item) => item.type === 'tool' && item.name === 'command' ? [item.id] : []))
	let outcomes = new Set(items.flatMap((item) => item.type === 'output' ? [item.text] : []))
	let formCursor: Frame['cursor'] | undefined
	let look = `${cols} ${session} ${itemView.resultRows()} ${items[0] ? ansi.sgr(itemView.itemStyle(items[0]) ?? {}) : ''} ${ansi.state.web.url}`
	let kept = frame.state.history
	let start = 0
	// A question can become active without its transcript item changing
	// (the blocked-state event follows the question). Never reuse its
	// inactive rows while the form is taking keys.
	if (kept?.look === look) while (start < kept.items.length && items[start] === kept.items[start]) {
		let item = items[start]!
		if (item.type === 'question' && item.id === view.form?.id) break
		start++
	}
	let lines = start ? kept!.lines.slice(0, kept!.ends[start - 1]) : []
	let ends = kept && start ? kept.ends.slice(0, start) : []
	let bash = kept && start ? kept.bash.filter((b) => b.at < start) : []
	for (let b of bash) calls.set(b.id, b.key)
	let stable = start
	let keep = () => {
		if (save) frame.state.history = { look, items: items.slice(0, stable), ends: ends.slice(0, stable), bash, lines }
	}
	for (let i = start; i < items.length; i++) {
		if (stable === i && i > start && performance.now() > deadline) {
			keep()
			return undefined
		}
		let item = items[i]!
		if (item.type === 'tool' && item.name === 'bash' && /^\d+(?:\.\d+)?$/.test(item.key)) {
			calls.set(item.id, item.key)
			bash.push({ at: i, id: item.id, key: item.key })
		}
		if (item.type === 'question' && view.form?.id === item.id) {
			let f = formView.formLines(view.form, width)
			// Padded like every block with a background (itemRows).
			let rows = f.rows.length ? ['', ...f.rows, ''] : []
			if (rows.length && lines.length) lines.push('')
			for (let r of rows) lines.push(...ansi.paintRows(r, itemView.itemStyle(item), cols))
			// Counted from the end: the question above may flow on.
			formCursor = { row: lines.length - (rows.length - 1 - f.cursor.row), col: ansi.PAD.length + f.cursor.col }
		} else {
			let streams = i === items.length - 1 && view.hal?.at === 'stream'
			let duplicate = item.type === 'tool-result' && commands.has(item.id) && outcomes.has(item.output)
			// A result right under its call needs no #<call> link to it.
			let prev = items[i - 1]
			let attached = item.type === 'tool-result' && (prev?.type === 'tool' || prev?.type === 'tool-result') && prev.id === item.id
			let rows = duplicate ? [] : frame.itemRows(item, cols, session, streams ? view.hal : undefined, calls, attached)
			rows = frame.highWater(rows, item, cols, session, streams)
			if (rows.length && lines.length) lines.push('')
			for (let r of rows) lines.push(r)
			// A streaming block or a question being answered is redrawn
			// every frame; so is everything after it.
			if (stable === i && !streams) stable++
		}
		ends.push(lines.length)
	}
	keep()
	let at = view.target ? items.findIndex((i) => i.key === view.target) : -1
	return { lines, ...(formCursor ? { formCursor } : {}), ...(at >= 0 ? { target: at ? ends[at - 1]! : 0 } : {}) }
}

// The frame for `view` on a terminal of `rows` × `cols`. `full`: full
// mode, where blank rows after a short history put the chrome on the
// screen's last rows, so the prompt is always at the bottom
// (tasks/cc/terminal.md, Height management). `past`: the items' rows
// (layout), laid out already.
function build(view: View, cols: number, rows = 24, full = false, past: Past = frame.layout(view, cols)!): Frame {
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	let lines: string[] = past.lines.slice()
	// Whether something is above `lines` (the history, above the chrome).
	let above = false
	let block = (rows: string[], style: Style | undefined) => {
		if (!rows.length) return
		if (lines.length || above) lines.push('')
		for (let r of rows) lines.push(...ansi.paintRows(r, style, cols))
	}
	let formCursor = view.form && past.target === undefined ? past.formCursor : undefined
	// Unsent and waiting messages use the normal prompt renderer; queued
	// ones stack as compact rows, the sender's tab number redrawn here.
	let session = view.transcript?.meta.id
	let waiting = view.transcript?.inbox ?? []
	let tail = [
		...waiting.map((m) => ({ item: transcript.waitingItem(m, waiting), m })),
		...(view.pending ?? []).map((text) => ({ item: { type: 'prompt', text, key: '' } as Item, m: undefined })),
	]
	// A stack of queued rows is one block: a padding row of its
	// background above the first and below the last, none between.
	let stacked = false
	let edge = ansi.paint('', colors.user(), cols)
	for (let { item, m } of tail) {
		let tab = m?.from === undefined ? 0 : (view.tabs?.list.findIndex((t) => t.id === m.from) ?? -1) + 1
		let queued = !!m?.queue && item.type === 'prompt'
		let rows = queued ? frame.queuedRows(item as Item & { type: 'prompt' }, inbox.note(m!, tab || undefined), cols, session) : frame.itemRows(item, cols, session)
		if (stacked && !queued) lines.push(edge)
		if (rows.length && (lines.length || above) && !(stacked && queued)) lines.push('')
		if (queued && !stacked) lines.push(edge)
		stacked = queued
		lines.push(...rows)
	}
	if (stacked) lines.push(edge)
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
	// Why the tab stopped, then a one-off notice, a rule between them.
	let told = [view.why, view.notice].filter((t) => t).map((t) => ansi.wrap(t!, width))
	block(told.flatMap((rows, i) => (i ? ['─'.repeat(width), ...rows] : rows)), { fg: colors.log().fg! })
	// Below them, the chrome proper: tab bar, the prompt box between
	// two rules, then the help row. Its height depends only on the
	// prompt's rows, so nothing below the transcript jumps.
	let p = promptView.box(view.prompt, width, view.placeholder)
	let input = colors.input()
	let rule = (left: string, center = '') => ansi.sgr(input) + promptView.rule(cols, left, ansi.clean(center)) + ansi.UNCOLOR
	if (lines.length || above) lines.push('')
	let anchor = lines.length
	if (view.tabs?.list.length) lines.push(tabBar.row(view.tabs.list, view.tabs.focused, cols, view.tabs.lit ?? true))
	lines.push(rule(p.above ? `↑${p.above}` : '', view.activity))
	let top = lines.length
	for (let r of p.rows) lines.push(ansi.paint(r, input, cols))
	lines.push(rule(p.below ? `↓${p.below}` : ''))
	lines.push(view.status ? statusRow.row(view.status, cols) : '')
	lines.push(helpRow.row(view, cols))
	// Keep the matched block's first row in the visible transcript area.
	if (past.target !== undefined) history = history.slice(0, past.target + Math.max(1, rows - lines.length))
	let pad = full ? Math.max(0, rows - lines.length - history.length) : 0
	let chrome = lines
	lines = history.concat(Array<string>(pad).fill(''), chrome)
	let grown = view.notices ? noticeView.overlay(lines, view.notices, history.length + pad + anchor, cols) : 0
	top += history.length + pad + grown
	let cursor = formCursor ?? { row: top + p.row, col: ansi.PAD.length + p.col }
	let out = { lines, cursor, promptScroll: p.scroll, history: history.length + grown }
	if (!view.modal) return out
	let m = modalView.withModal(lines, view.modal, rows, cols)
	return { ...out, cursor: m.cursor, modalScroll: m.scroll }
}

// `history`: the last frame's transcript rows (lines), where each of its
// first items ends in them and its bash calls (the job ids results show); forgotten with the peaks on a full redraw.
type History = { look: string; items: Item[]; ends: number[]; bash: { at: number; id: string; key: string }[]; lines: string[] }

export const frame = { state: { rows: new WeakMap<Item, { key: string; rows: string[] }>(), peaks: new Map<string, number>(), history: undefined as History | undefined }, layout, build, itemRows, ref, queuedRows, highWater, glyph, withCursor, promptWidth }
