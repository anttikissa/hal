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
import { batchOrder, type Ordering } from './batch-order.ts'
import { formView } from './form-view.ts'
import { itemView, type Look } from './item-view.ts'
import { toggle, type Fold } from '../common/toggle.ts'
import { modalView } from './modal-view.ts'
import { noticeView } from './notice-view.ts'
import type { Folded } from '../common/notices.ts'
import type { PromptState } from '../common/prompt.ts'
import type { Tab } from '../common/protocol.ts'
import { promptView } from './prompt-view.ts'
import { halCursor, type HalCursor } from './hal-cursor.ts'
import { tabBar } from './tab-bar.ts'
import { helpRow, type Hint } from './help-row.ts'
import { statusRow, type StatusInfo } from './status-row.ts'
import { strings } from '../common/strings.ts'
import { promptChanges } from '../common/prompt-changes.ts'
import { toolDetails } from '../common/tool-details.ts'

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
	/** Tab completion's choices: listed in the help row, or described
	 * one per row in the help area (task 4qh). */
	choices?: string[] | Hint[]
	/** What the session is doing, centered in the prompt's top rule. */
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
	/** Toggled blocks' states and inline pastes (task ghs); `sig`
	 * changes with them. */
	folds?: Look & { states: Map<string, Fold>; sig: string }
	/** The running tool call and its elapsed time, "12s" (task wm0). */
	tick?: { call: string; label: string }
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
	/** The transcript items in it and the row each ends at (Past). */
	items?: Item[]
	ends?: number[]
}

// The prompt's content width on a terminal `cols` wide: what Up/Down
// move through.
function promptWidth(cols: number): number {
	return Math.max(1, cols - 2 * ansi.PAD.length)
}

// An item's painted rows on a terminal `cols` wide. An item with a
// block id shows it dim at the right of its first row, `#t35`, an OSC 8
// link to the same block on the web (tasks wc, 0z); a gutter as wide
// as the id is kept free on every row, as the web keeps a column for
// it. `hal`: the item streams, so the Hal cursor follows its last
// character. Items never change in place (a change is a new item), so
// each is laid out once per width and look, not on every frame: a long
// history stays cheap to redraw. A kept row keeps the link code it was
// painted with (task e3 notes).
// `status`: a tool call's, after its title (task wm0).
// `look`: its fold state and inline pastes (task ghs).
function itemRows(item: Item, cols: number, session?: string, hal?: HalCursor, calls?: Map<string, string>, tool?: string, images: Item[] = [], status = '', look: Look = {}): string[] {
	let style = itemView.itemStyle(item, tool)
	// The web address is in every item's link: a server that bound after
	// the first paint (another port) must reach rows laid out before it.
	let key = `${cols} ${itemView.resultRows} ${style ? ansi.sgr(style) : ''} ${session} ${item.key} ${item.type === 'tool-result' ? `${calls?.get(item.id) ?? ''}${tool ? `^${tool}` : ''}` : ''} ${images.map((i) => i.key).join(',')} ${ansi.state.web.url} ${status} ${look.fold ?? ''}${look.full ? 'full' : ''}${look.fold === 'inline' ? toggle.pastes(item).map((n) => `${n}${look.pastes?.get(n)?.text !== undefined ? '+' : '-'}`).join() : ''}`
	let kept = hal ? undefined : frame.state.rows.get(item)
	if (kept?.key === key) return kept.rows
	let { inner, mark } = frame.ref(item, cols, session, style, status)
	let lines = itemView.itemLines(item, inner, !!hal, session, calls, tool, images, look)
	if (hal) lines = halCursor.withCursor(lines, hal, inner)
	// A block with a background has a row of it above and below its
	// text, as the old Hal drew prompt cards; the id goes below the top.
	// Closed blocks too: a card without them looks broken.
	let padded = !!style?.bg && lines.length > 0
	if (padded) lines = ['', ...lines, '']
	mark(lines, padded ? 1 : 0)
	let rows = lines.flatMap((r) => ansi.paintRows(r, style, cols))
	if (!hal) frame.state.rows.set(item, { key, rows })
	return rows
}

// The text width beside an item's id, and how to put the id on row
// `at`, after `status` if there is one; the row is clipped to make room.
function ref(item: Item, cols: number, session: string | undefined, style: Style | undefined, status = ''): { inner: number; mark: (lines: string[], at: number) => void } {
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	let ref = itemView.ref(item, session)
	// On a very narrow terminal the text needs every column.
	if (ref && width < 4 * strings.visLen(ref.text)) ref = undefined
	let inner = ref ? Math.max(1, width - strings.visLen(ref.text) - 1) : width
	let mark = (lines: string[], at: number) => {
		if ((!ref && !status) || lines.length <= at) return
		let link = ref ? ansi.quiet(`\x1b]8;;${ansi.webUrl(ref.href)}\x07${ref.text}${ansi.LINK_OFF}`, style) : ''
		let end = status && link ? `${status} ${link}` : status || link
		if (status) lines[at] = itemView.right(lines[at]!, end, width)
		else lines[at] += ' '.repeat(Math.max(1, width - strings.visLen(lines[at]!) - strings.visLen(ref!.text))) + link
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

// A call's card, with its results, never shrinks either: a running
// call's last output lines give way to a shorter result glimpse, and in
// full mode one row less clears scrollback, snapping the terminal to the
// bottom. Blank card rows at its end keep the tallest height drawn at
// this width and fold state until the next full redraw; folding with
// /collapse starts afresh.
function cardWater(lines: string[], start: number, id: string, style: Style | undefined, cols: number): void {
	let peaks = frame.state.peaks, height = lines.length - start, peak = peaks.get(id) ?? 0
	if (height >= peak) peaks.set(id, height)
	else for (let n = height; n < peak; n++) lines.push(ansi.paint('', style, cols))
}

// `items`/`ends`: the items laid out and the row each ends at, so a
// row can be traced to its block (render.clear's reasons, task e4c).
export type Past = { lines: string[]; items?: Item[]; ends?: number[]; formCursor?: Frame['cursor']; target?: number; tick?: { row: number; labeled: string; plain: string } }

// Lays out the transcript's items. The rows of items drawn last time
// and unchanged since are reused as they are: a frame costs what
// changed, not the whole history. With a `deadline`, stops at the first
// stable item once it is past (after laying out at least one) and
// returns nothing; what was laid out is kept (unless `save` is false),
// so the next call goes on from there: a long history is laid out in
// slices (task 7j).
function layout(view: View, cols: number, deadline = Infinity, save = true, screen = 24): Past | undefined {
	let session = view.transcript?.meta.id
	// The batch's rows as drawn grouped: each call and its gap; each
	// result continues its call's card, replacing the bottom padding row.
	// A call still waiting counts a one-row result (2 rows more), so a
	// batch rarely groups first and splits once its results arrive.
	let height = (batch: Item[]) => batch.reduce((n, item) => {
		if (item.type === 'tool' && !batch.some((r) => r.type === 'tool-result' && r.id === item.id)) n += 2
		let call = item.type === 'tool-result' ? batch.find((c) => c.type === 'tool' && c.id === item.id) : undefined
		return n + (call?.type === 'tool' ? frame.itemRows(item, cols, session, undefined, undefined, call.name).length - 1 : frame.itemRows(item, cols, session).length + 1)
	}, 0)
	// Ordered once per transcript (updates replace its items), in slices
	// (task 7j); an unsaved layout (render.tail's) leaves the memo alone.
	let src = view.transcript?.items ?? [], memo = frame.state.ordered, how = `${cols} ${screen} ${session} ${src.length}`
	let fits = (batch: Item[]) => height(batch) <= screen
	if (!save) memo = { src, how, grouped: [], at: { i: 0, out: frame.order(promptChanges.group(src), fits) } }
	else if (memo?.src !== src || memo.how !== how) memo = { src, how, grouped: promptChanges.group(src), at: { i: 0, out: [] } }
	if (memo.at.i < memo.grouped.length) memo.at = frame.order(memo.grouped, fits, deadline, memo.at)
	if (save) frame.state.ordered = memo
	if (memo.at.i < memo.grouped.length) return undefined
	let items = memo.at.out
	let calls = new Map<string, string>()
	// A result opens and closes with its call (task ghs).
	let callKeys = new Map<string, string>()
	let formCursor: Frame['cursor'] | undefined
	let tick: Past['tick']
	// The call whose card is being laid out: its first row and fold key.
	let card: { id: string; key: string; start: number } | undefined
	let look = `${cols} ${session} ${itemView.resultRows} ${items[0] ? ansi.sgr(itemView.itemStyle(items[0]) ?? {}) : ''} ${ansi.state.web.url} ${view.folds?.sig ?? ''}`
	let kept = frame.state.history
	let start = 0
	// A question can become active without its transcript item changing
	// (the blocked-state event follows the question). Never reuse its
	// inactive rows while the form is taking keys.
	// A call's title shows its result's status, or its running time.
	if (kept?.look === look) while (start < kept.items.length && items[start] === kept.items[start]) {
		let item = items[start]!
		if (item.type === 'question' && item.id === view.form?.id) break
		if (item.type === 'tool' && (item.id === view.tick?.call || items[start + 1] !== kept.items[start + 1])) break
		if (item.type === 'tool-result' && items[start + 1] !== kept.items[start + 1]) break
		start++
	}
	// A call is laid out with all its results, so its card is measured whole.
	while (start > 0 && items[start]?.type === 'tool-result') start--
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
		if (item.type === 'tool') callKeys.set(item.id, item.key)
		let look: Look = { fold: view.folds?.states.get(item.type === 'tool-result' ? callKeys.get(item.id) ?? '' : item.key), pastes: view.folds?.pastes }
		if (item.type === 'tool' && item.name === 'bash' && /^\d+(?:\.\d+)?$/.test(item.key)) {
			calls.set(item.id, item.key)
			bash.push({ at: i, id: item.id, key: item.key })
		}
		if (item.type === 'question' && view.form?.id === item.id) {
			let { inner, mark } = frame.ref(item, cols, session, itemView.itemStyle(item)) // its id, like every block's
			let f = formView.formLines(view.form, inner, item.ts)
			let rows = f.rows.length ? ['', ...f.rows, ''] : [] // padded like itemRows
			mark(rows, 1)
			if (rows.length && lines.length) lines.push('')
			for (let r of rows) lines.push(...ansi.paintRows(r, itemView.itemStyle(item), cols))
			// Counted from the end: the question above may flow on.
			formCursor = { row: lines.length - (rows.length - 1 - f.cursor.row), col: ansi.PAD.length + f.cursor.col }
		} else {
			let streams = i === items.length - 1 && view.hal?.at === 'stream'
			// A result right under its call (or another of its results)
			// continues the call's card: no #<call> link, and its padding
			// row stands where the call's bottom one and the gap were.
			let tool: string | undefined
			if (item.type === 'tool-result') for (let j = i - 1; j >= 0; j--) {
				let prev = items[j]!
				if ((prev.type !== 'tool' && prev.type !== 'tool-result') || prev.id !== item.id) break
				if (prev.type === 'tool') { tool = prev.name; if (toolDetails.fullCommand(prev.name, prev.input)) { look.full = true; look.fold ??= 'closed' } }
			}
			// A prompt's images join its card; they draw nothing alone.
			let images: Item[] = []
			if (item.type === 'prompt') for (let j = i + 1; items[j]?.type === 'image'; j++) images.push(items[j]!)
			let merged = item.type === 'image' && ['prompt', 'image'].includes(items[i - 1]?.type ?? '')
			// A call shows its attached result's status, or while it
			// runs, its elapsed time (task wm0).
			let ticks = item.type === 'tool' && item.id === view.tick?.call
			let status = ''
			if (item.type === 'tool') {
				let style = itemView.itemStyle(item), next = items[i + 1]
				if (ticks) status = itemView.status(undefined, view.tick!.label, style)
				else if (next?.type === 'tool-result' && next.id === item.id) status = itemView.resultStatus(next, item.name === 'bash', style)
			}
			let rows = merged ? [] : frame.itemRows(item, cols, session, streams ? view.hal : undefined, calls, tool, images, status, look)
			rows = frame.highWater(rows, item, cols, session, streams)
			if (tool && rows.length && lines.length) lines.pop()
			else if (rows.length && lines.length) lines.push('')
			for (let r of rows) lines.push(r)
			if (item.type === 'tool') card = { id: item.id, key: item.key, start: lines.length - rows.length }
			let next = items[i + 1]
			if (card && (item.type === 'tool' || item.type === 'tool-result') && item.id === card.id && !(next?.type === 'tool-result' && next.id === card.id)) {
				frame.cardWater(lines, card.start, `${cols} ${session} call ${card.key} ${look.fold ?? ''}${look.full ? 'full' : ''}`, itemView.itemStyle(item, tool), cols)
				card = undefined
			}
			if (ticks) {
				let plain = frame.itemRows(item, cols, session, undefined, calls, tool, images, '', look)
				let k = rows.findIndex((r, j) => r !== plain[j])
				if (k >= 0 && rows.length === plain.length) tick = { row: lines.length - rows.length + k, labeled: rows[k]!, plain: plain[k]! }
			}
			// A streaming block, a ticking call or a question being
			// answered is redrawn every frame; so is everything after it.
			if (stable === i && !streams && !ticks) stable++
		}
		ends.push(lines.length)
	}
	keep()
	let at = view.target ? items.findIndex((i) => i.key === view.target) : -1
	// An image drawn in its prompt's card is found at that card.
	while (at > 0 && items[at]!.type === 'image' && ['prompt', 'image'].includes(items[at - 1]!.type)) at--
	return { lines, items, ends, ...(formCursor ? { formCursor } : {}), ...(at >= 0 ? { target: at ? ends[at - 1]! : 0 } : {}), ...(tick ? { tick } : {}) }
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
	// The idle Hal cursor: a blank row, its row, and the blank row that
	// comes before the chrome. A question being answered has the cursor.
	// It is the work now, so it comes before waiting messages (the future).
	if (view.hal?.at === 'idle' && !formCursor) {
		// Normalize only the tail gap, including ANSI-painted padding (task fcn).
		let end = lines.length
		while (end) {
			let row = lines[end - 1]!, visible = false
			strings.walk(row, 0, (i, _width, length) => { if (row.slice(i, i + length).trim()) visible = true })
			if (visible) break
			end--
		}
		if (end < lines.length) lines.length = end ? end + 1 : 0
		else if (lines.length || above) lines.push('')
		lines.push(ansi.PAD + halCursor.glyph(view.hal))
	}
	// Unsent and waiting messages use the normal prompt renderer; queued
	// ones stack as compact rows, the sender's tab number redrawn here.
	let session = view.transcript?.meta.id
	let waiting = view.transcript?.inbox ?? []
	let tail = [
		...waiting.map((m) => ({ item: transcript.waitingItem(m), m })),
		...(view.pending ?? []).map((text) => ({ item: { type: 'prompt', text, key: '' } as Item, m: undefined })),
	]
	// A stack of queued rows is one block: a padding row of its
	// background above the first and below the last, none between.
	let stacked = false
	let edge = ansi.paint('', colors.user(), cols)
	for (let { item, m } of tail) {
		let tab = m?.from === undefined ? 0 : (view.tabs?.list.findIndex((t) => t.id === m.from) ?? -1) + 1
		let queued = !!m?.queue && item.type === 'prompt'
		let rows = queued ? frame.queuedRows(item as Item & { type: 'prompt' }, inbox.note(m!, tab || undefined, m!.id === view.transcript?.queueHold), cols, session) : frame.itemRows(item, cols, session)
		if (stacked && !queued) lines.push(edge)
		if (rows.length && (lines.length || above) && !(stacked && queued)) lines.push('')
		if (queued && !stacked) lines.push(edge)
		stacked = queued
		lines.push(...rows)
	}
	if (stacked) lines.push(edge)
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
	let over = view.tabs?.list.length ? tabBar.overRow(view.tabs.list, view.tabs.focused, cols) : undefined
	if (over !== undefined) lines.push(over)
	else if (lines.length || above) lines.push('')
	let anchor = lines.length
	if (view.tabs?.list.length) lines.push(tabBar.row(view.tabs.list, view.tabs.focused, cols, view.tabs.lit ?? true))
	lines.push(rule(p.above ? `↑${p.above}` : '', view.activity))
	let top = lines.length
	for (let r of p.rows) lines.push(ansi.paint(r, input, cols))
	lines.push(rule(p.below ? `↓${p.below}` : ''))
	lines.push(view.status ? statusRow.row(view.status, cols) : '')
	// Text near the box's height earns the resize hint (task 0nj).
	lines.push(...helpRow.rows(view, cols, !!view.prompt.text.trim() && p.total >= Math.max(1, p.limit - 2)))
	// Keep the matched block's first row in the visible transcript area.
	if (past.target !== undefined) history = history.slice(0, past.target + Math.max(1, rows - lines.length))
	let pad = full ? Math.max(0, rows - lines.length - history.length) : 0
	let chrome = lines
	lines = history.concat(Array<string>(pad).fill(''), chrome)
	let grown = view.notices ? noticeView.overlay(lines, view.notices, history.length + pad + anchor, cols) : 0
	// A ticking time scrolled into scrollback would stay there stale,
	// and rewriting it there forces a full repaint: off the screen, the
	// row goes without it (task wm0).
	let tick = past.tick
	if (tick && lines.length - tick.row > rows && lines[tick.row] === tick.labeled) lines[tick.row] = tick.plain
	top += history.length + pad + grown
	let cursor = formCursor ?? { row: top + p.row, col: ansi.PAD.length + p.col }
	let out = { lines, cursor, promptScroll: p.scroll, history: history.length + grown, items: past.items, ends: past.ends }
	if (!view.modal) return out
	let m = modalView.withModal(lines, view.modal, rows, cols)
	return { ...out, cursor: m.cursor, modalScroll: m.scroll }
}

// `history`: the last frame's transcript rows (lines), where each of its
// first items ends in them and its bash calls (the job ids results show); forgotten with the peaks on a full redraw.
type History = { look: string; items: Item[]; ends: number[]; bash: { at: number; id: string; key: string }[]; lines: string[] }

export const frame = { state: { rows: new WeakMap<Item, { key: string; rows: string[] }>(), peaks: new Map<string, number>(), history: undefined as History | undefined, ordered: undefined as { src: Item[]; how: string; grouped: Item[]; at: Ordering } | undefined }, layout, build, itemRows, ref, queuedRows, highWater, cardWater, order: batchOrder.order, promptWidth }
