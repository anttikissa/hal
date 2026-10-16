// The frame: every row the terminal should show, from the first
// transcript item to the prompt, and where the cursor goes. Pure; the
// renderer (render.ts) decides how to get it onto the terminal.

import { bashResult } from '../common/bash-result.ts'
import { card, type Verbosity } from '../common/card.ts'
import { colors, type Style } from '../common/colors.ts'
import { forms, type FormState } from '../common/forms.ts'
import type { ModalState } from '../common/modals.ts'
import { inbox } from '../common/inbox.ts'
import { transcript, type Item, type Transcript } from '../common/transcript.ts'
import { ansi } from './ansi.ts'
import { batchOrder, type Ordering } from './batch-order.ts'
import { formView } from './form-view.ts'
import { itemView, type Look } from './item-view.ts'
import { water } from './water.ts'
import { bashCard } from './bash-card.ts'
import { modalView } from './modal-view.ts'
import { noticeView } from './notice-view.ts'
import type { Folded } from '../common/notices.ts'
import type { Shown } from '../common/placeholders.ts'
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
import { settings } from '../common/settings.ts'
import { toolView } from './tool-view.ts'

export interface View {
	transcript?: Transcript
	/** Where replayed history ends: a line there says it is old. */
	prompt: PromptState
	/** Prompts sent but not yet acknowledged by the host. */
	pending?: string[]
	/** Why the tab stopped (an error, a block, a pause reason): its state. */
	why?: string
	/** A passing message for the user, such as a refused command. */
	notice?: string
	noticeClearable?: boolean
	/** The open question being answered here: keys and cursor go to it. */
	form?: FormState
	/** A dim example request over the prompt (placeholders.follow). */
	placeholder?: Shown
	/** A modal drawn over everything: keys and cursor go to it. */
	modal?: ModalState
	/** The host's tabs and the one shown: a tab bar row above the prompt;
	 * `lit` is the blink phase while an indicator blinks. */
	tabs?: { list: Tab[]; focused?: string; lit?: boolean; alt?: boolean }
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
	/** Help row: newCode offers ctrl-r; noUser (hal --no-user) says USER.md is off. */
	newCode?: boolean; noUser?: boolean
	/** The notice stack, over the rows just above the tab bar (task qm). */
	notices?: Folded
	/** Toggled blocks' states (task ghs); `sig` changes with them. */
	folds?: { states: Map<string, Verbosity>; sig: string }
	/** The running call's elapsed time, "12s" (task wm0), and spinner (task
	 * hyt); without `call`, the streaming last item's. */
	tick?: { call?: string; label: string; spin: string }
	/** The clock while a Bash command scrolls (bash-card.ts). */
	now?: number
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
// it. `hal`: the item streams: a long block's Hal cursor follows its
// last character, the others show their spinner. Items never change
// in place (a change is a new item), so each is laid out once per width
// and look, not on every frame: a long history stays cheap to redraw.
// A kept row keeps the link code it was painted with (task e3 notes).
// `status`: after the title: a call's (task wm0), a live block's
// elapsed time and spinner cell (task hyt). `look`: its verbosity
// (tasks ghs, hyt).
function itemRows(item: Item, cols: number, session?: string, hal?: HalCursor, calls?: Map<string, string>, tool?: string, images: Item[] = [], status = '', look: Look = {}): string[] {
	let style = look.style ?? itemView.itemStyle(item, tool)
	if (item.type === 'prompt' && bashResult.background(item)) status = toolView.resultStatus({ output: item.text }, true, style)
	// The web address is in every item's link: a server that bound after
	// the first paint (another port) must reach rows laid out before it.
	let scroll = frame.scrolls(item, look.now) ? look.now : ''
	let key = `${cols} ${settings.shortRows()} ${style ? ansi.sgr(style) : ''} ${session} ${item.key} ${item.type === 'tool-result' ? `${calls?.get(item.id) ?? ''}${tool ? `^${tool}` : ''}${look.call?.key ?? ''}` : ''} ${images.map((i) => i.key).join(',')} ${ansi.state.web.url} ${status} ${look.fold ?? ''}${look.full ? 'full' : ''} ${look.pad ?? ''} ${look.result?.key ?? ''} ${look.lines ? 'own' : ''} ${look.head ?? ''} ${look.streamRows ?? ''} ${look.call?.title ?? ''} ${look.wait?.map((p) => typeof p === 'string' ? p : p.text).join('') ?? ''} ${scroll}`
	let kept = hal ? undefined : frame.state.rows.get(item)
	if (kept?.key === key) return kept.rows
	let { inner, head, mark } = itemView.place(item, cols, session, style, status)
	let lines = look.lines?.(inner) ?? itemView.itemLines(item, inner, !!hal, session, calls, tool, images, { ...look, headerWidth: head })
	if (look.streamRows !== undefined && lines.length > look.streamRows) lines = [lines[0]!, ...(look.streamRows > 1 ? lines.slice(-(look.streamRows - 1)) : [])]
	if (hal && (look.fold ?? card.initial(item)) === 'long') lines = halCursor.withCursor(lines, hal, inner)
	// A block with a background has a row of it above and below its
	// text, as the old Hal drew prompt cards; the id goes below the top.
	// Closed blocks too: a card without them looks broken. look.pad decides.
	let padded = (look.pad ?? !!style?.bg) && lines.length > 0
	if (padded) lines = ['', ...lines, '']
	mark(lines, padded ? 1 : 0)
	let rows = lines.flatMap((r) => ansi.paintRows(r, style, cols))
	if (!hal) frame.state.rows.set(item, { key, rows })
	return rows
}

// How `item` is drawn (plugin hook): `look` as the layout made it.
// A plugin may fold it, give it a result-aware headline (look.result),
// drop its padding (pad: false) or the blank row above it (gap: false),
// replace its status after the title, its style, or draw its rows itself
// (lines(width), painted in look.style).
function look(_item: Item, look: Look): Look {
	return look
}

// Queued cards share their sender's style, whether compact or expanded.
function queuedRows(item: Item & { type: 'prompt' }, note: string, cols: number, session?: string, look: Look = {}): string[] {
	if ((look.fold ?? card.initial(item)) !== 'short') return frame.itemRows(item, cols, session, undefined, undefined, undefined, [], '', { ...look, pad: false })
	let style = itemView.itemStyle(item)
	let { inner, mark } = itemView.place(item, cols, session, style)
	let lines = [strings.clipVisual(ansi.clean(`${note} ${card.text(item)}`.split('\n')[0]!).replace(/\s+/g, ' '), inner)]
	mark(lines, 0)
	return lines.flatMap((r) => ansi.paintRows(r, style, cols))
}

// `items`/`ends`: the items laid out and the row each ends at, so a
// row can be traced to its block (render.clear's reasons, task e4c).
export type Past = { lines: string[]; items?: Item[]; ends?: number[]; formCursor?: Frame['cursor']; tick?: { row: number; labeled: string; plain: string } }

// Lays out the transcript's items. The rows of items drawn last time
// and unchanged since are reused as they are: a frame costs what
// changed, not the whole history. With a `deadline`, stops at the first
// stable item once it is past (after laying out at least one) and
// returns nothing; what was laid out is kept (unless `save` is false),
// so the next call goes on from there: a long history is laid out in
// slices (task 7j).
function layout(view: View, cols: number, deadline = Infinity, save = true, screenRows = 24): Past | undefined {
	let session = view.transcript?.meta.id
	// Ordered once per transcript (updates replace its items), in slices
	// (task 7j); an unsaved layout (render.tail's) leaves the memo alone.
	let src = view.transcript?.items ?? [], memo = frame.state.ordered, how = `${session} ${src.length}`
	if (!save) memo = { src, how, grouped: [], at: { i: 0, out: frame.order(promptChanges.group(src)) } }
	else if (memo?.src !== src || memo.how !== how) memo = { src, how, grouped: promptChanges.group(src), at: { i: 0, out: [] } }
	if (memo.at.i < memo.grouped.length) memo.at = frame.order(memo.grouped, deadline, memo.at)
	if (save) frame.state.ordered = memo
	if (memo.at.i < memo.grouped.length) return undefined
	let items = memo.at.out
	let calls = new Map<string, string>()
	let toolCalls = new Map<string, { key: string; name: string; title?: string }>()
	let callFolds = new Map<string, Verbosity>()
	let formCursor: Frame['cursor'] | undefined
	let tick: Past['tick']
	// The call whose card is being laid out: its first row and fold key.
	let callCard: { id: string; key: string; start: number } | undefined
	// The output region of a split batch being laid out (task 5gn).
	let below: { key: string; start: number } | undefined
	// The look of the last item that drew rows.
	let drawn: Look | undefined
	let blocks = forms.cards(view.form, view.transcript?.meta.blocks)
	let look = `${cols} ${screenRows} ${session} ${card.signature(blocks)} ${items[0] ? ansi.sgr(itemView.itemStyle(items[0]) ?? {}) : ''} ${ansi.state.web.url} ${view.folds?.sig ?? ''}`
	let kept = frame.state.history
	let start = 0
	// A question can become active without its transcript item changing
	// (the blocked-state event follows the question). Never reuse its
	// inactive rows while the form is taking keys.
	// A call's title shows its result's status, or its running time.
	if (kept?.look === look) while (start < kept.items.length && items[start] === kept.items[start]) {
		let item = items[start]!
		if (item.type === 'question' && item.id === view.form?.id) break
		if (item.type === 'tool' && (item.id === view.tick?.call || items[start + 1] !== kept.items[start + 1] || frame.scrolls(item, view.now))) break
		if (item.type === 'tool-result' && items[start + 1] !== kept.items[start + 1]) break
		start++
	}
	// A call is laid out with all its results, so its card is measured whole.
	while (start > 0 && items[start]?.type === 'tool-result') start--
	let lines = start ? kept!.lines.slice(0, kept!.ends[start - 1]) : []
	let ends = kept && start ? kept.ends.slice(0, start) : []
	let tools = kept && start ? kept.tools.filter((b) => b.at < start) : []
	for (let b of tools) {
		toolCalls.set(b.id, b)
		callFolds.set(b.id, b.fold)
		if (b.name === 'bash') calls.set(b.id, b.key)
	}
	let stable = start
	let keep = () => {
		if (save) frame.state.history = { look, items: items.slice(0, stable), ends: ends.slice(0, stable), tools, lines }
	}
	let imageStart = start
	while (imageStart > 0 && items[imageStart - 1]?.type === 'image') imageStart--
	let imagePrompt = items[imageStart - 1]?.type === 'prompt'
	for (let i = start; i < items.length; i++) {
		if (stable === i && i > start && performance.now() > deadline) {
			keep()
			return undefined
		}
		let item = items[i]!
		if (item.type !== 'image') imagePrompt = item.type === 'prompt'
		// Toggled here, or as the session starts its kind (task hyt); a
		// call fails with its result.
		let res = batchOrder.state.apart.has(item) ? undefined : items[i + 1], failed = item.type === 'tool' && res?.type === 'tool-result' && res.id === item.id && card.failed(res, item.name === 'bash')
		let fold = item.type === 'tool-result' ? callFolds.get(item.id) ?? 'short' : view.folds?.states.get(item.key) ?? card.initial(item, blocks, failed)
		if (item.type === 'tool') callFolds.set(item.id, fold)
		let look: Look = { fold }
		if (item.type === 'tool') {
			let title = item.presentation?.title ?? toolDetails.headline(item.name, item.input).text
			toolCalls.set(item.id, { key: item.key, name: item.name, title })
			tools.push({ at: i, id: item.id, key: item.key, name: item.name, title, fold })
			if (item.name === 'bash') calls.set(item.id, item.key)
		} else if (item.type === 'tool-result') {
			look.call = toolCalls.get(item.id)
			if (look.call) look.style = itemView.itemStyle(item, look.call.name)
		}
		if (item.type === 'question' && view.form?.id === item.id) {
			let { inner, mark } = itemView.place(item, cols, session, itemView.itemStyle(item)) // its id, like every block's
			let f = formView.formLines(view.form, inner, item.ts)
			let rows = f.rows.length ? ['', ...f.rows, ''] : [] // padded like itemRows
			mark(rows, 1)
			if (rows.length && lines.length) lines.push('')
			for (let r of rows) lines.push(...ansi.paintRows(r, itemView.itemStyle(item), cols))
			// Counted from the end: the question above may flow on.
			formCursor = { row: lines.length - (rows.length - 1 - f.cursor.row), col: ansi.PAD.length + f.cursor.col }
		} else {
			let streams = i === items.length - 1 && view.hal?.at === 'stream'
			// Adjacent results continue their call's card without a reference or gap.
			let tool: string | undefined
			if (item.type === 'tool-result') for (let j = i - 1; j >= 0; j--) {
				let prev = items[j]!
				if ((prev.type !== 'tool' && prev.type !== 'tool-result') || prev.id !== item.id) break
				if (prev.type === 'tool' && batchOrder.state.apart.has(prev)) break
				if (prev.type === 'tool') { tool = prev.name; look.head = toolView.heads.get(prev); if (toolDetails.fullCommand(prev.name, prev.input)) look.full = true }
			}
			let images: Item[] = []
			if (item.type === 'prompt') for (let j = i + 1; items[j]?.type === 'image'; j++) images.push(items[j]!)
			let merged = item.type === 'image' && imagePrompt
			// Status and the reserved spinner cell keep call headers stable
			// (task hyt); a call whose output is drawn below shows ↓ there.
			let ticks = item.type === 'tool' && item.id === view.tick?.call
			let live = ticks || (streams && !!view.tick && view.tick.call === undefined)
			let cell = item.type === 'tool' || item.type === 'thinking' || item.type === 'text' ? (live ? view.tick!.spin : batchOrder.state.apart.has(item) ? ansi.quiet('↓', itemView.itemStyle(item)) : '') : ''
			if (item.type === 'tool' && res?.type === 'tool-result' && res.id === item.id) look.result = res
			if (item.type === 'tool' && !item.presentation && !look.result?.presentation) {
				let h = toolDetails.headline(item.name, item.input, look.result?.output)
				if (h.mark === '…') look.wait = toolDetails.waiting(h.text, session ?? '', src, view.tabs?.list)
			}
			let limit = item.type === 'tool' ? toolDetails.limit(item.name, item.input) : undefined
			if (live) look.status = toolView.status(undefined, view.tick!.label, itemView.itemStyle(item), limit)
			else if (look.result) look.status = toolView.resultStatus(look.result, item.type === 'tool' && item.name === 'bash', itemView.itemStyle(item), limit, fold === 'short' && settings.shortRows() === 1)
			if (item.type === 'tool' && item.name === 'bash' && view.now !== undefined) look.now = view.now
			if (cell) look.status = look.status ? `${look.status} ${cell}` : cell
			if (item.type === 'tool' && item.name === 'bash' && item.input.background === true) look.status = look.status?.trimEnd() ? `${look.status.trimEnd()} &` : '&'
			if (fold === 'long' && ((item.type === 'tool' && item.partial !== undefined && !look.result) || (item.type === 'tool-result' && (item as Item & { live?: boolean }).live))) look.streamRows = Math.max(1, Math.floor(screenRows / 2) - 10)
			look = frame.look(item, look)
			let rows = merged ? [] : frame.itemRows(item, cols, session, streams ? view.hal : undefined, calls, tool, images, look.status, look)
			let natural = rows.length
			rows = water.high(frame.state.peaks, rows, item, cols, session, streams)
			if (rows.length > natural) frame.state.padded = true
			let region = item.type === 'tool-result' && !tool ? batchOrder.state.below.get(item) : undefined
			if (region && below?.key !== region) below = { key: region, start: lines.length }
			// An attached result follows its call's last row: both padding rows go.
			if (tool && rows.length && lines.length && drawn?.pad !== false) {
				lines.pop()
				if (!Bun.stripANSI(rows[0]!).trim()) rows = rows.slice(1)
			}
			else if (rows.length && look.gap !== false && (lines.length || Bun.stripANSI(rows[0]!).trim())) lines.push('')
			if (rows.length) drawn = look
			for (let r of rows) lines.push(r)
			if (item.type === 'tool' && !batchOrder.state.apart.has(item)) callCard = { id: item.id, key: item.key, start: lines.length - rows.length }
			let next = items[i + 1]
			// A split batch's output region never shrinks either: its live
			// rows give way to the results (task 5gn).
			if (region && below && !(next && batchOrder.state.below.get(next) === region)) {
				let natural = lines.length
				water.card(frame.state.peaks, lines, below.start, `${cols} ${screenRows} ${session} below ${region} ${look.fold ?? ''}`, look.style, cols)
				if (lines.length > natural) frame.state.padded = true
				below = undefined
			}
			if (callCard && (item.type === 'tool' || item.type === 'tool-result') && item.id === callCard.id && !(next?.type === 'tool-result' && next.id === callCard.id)) {
				let natural = lines.length
				water.card(frame.state.peaks, lines, callCard.start, `${cols} ${screenRows} ${session} call ${callCard.key} ${look.fold ?? ''}${look.full ? 'full' : ''}`, itemView.itemStyle(item, tool), cols)
				if (lines.length > natural) frame.state.padded = true
				callCard = undefined
			}
			if (ticks) {
				let plain = frame.itemRows(item, cols, session, undefined, calls, tool, images, ' ', look)
				let k = rows.findIndex((r, j) => r !== plain[j])
				if (k >= 0 && rows.length === plain.length) tick = { row: lines.length - rows.length + k, labeled: rows[k]!, plain: plain[k]! }
			}
			// A streaming block, a ticking call or a question being
			// answered is redrawn every frame; so is everything after it.
			if (stable === i && !streams && !ticks && !frame.scrolls(item, view.now)) stable++
		}
		ends.push(lines.length)
	}
	keep()
	return { lines, items, ends, ...(formCursor ? { formCursor } : {}), ...(tick ? { tick } : {}) }
}

// The frame for `view` on a terminal of `rows` × `cols`. `full`: full
// mode, where blank rows after a short history put the chrome on the
// screen's last rows, so the prompt is always at the bottom
// (tasks/cc/terminal.md, Height management). `past`: the items' rows
// (layout), laid out already.
function build(view: View, cols: number, rows = 24, full = false, past: Past = frame.layout(view, cols, Infinity, true, rows)!): Frame {
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	let lines: string[] = past.lines.slice()
	let block = (rows: string[], style: Style | undefined) => {
		if (!rows.length) return
		lines.push('')
		for (let r of rows) lines.push(...ansi.paintRows(r, style, cols))
	}
	let formCursor = view.form ? past.formCursor : undefined
	// The idle Hal cursor: a blank row, its row, and the blank row that
	// comes before the chrome. A question being answered has the cursor.
	// It is the work now, so it comes before waiting messages (the future).
	if (view.hal?.at === 'idle' && !formCursor) {
		lines.push('')
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
	let stacked: string | undefined
	for (let { item, m } of tail) {
		let tab = m?.from === undefined ? 0 : (view.tabs?.list.findIndex((t) => t.id === m.from) ?? -1) + 1
		let queued = !!(m?.delivery === 'after-turn') && item.type === 'prompt'
		let look: Look = { fold: view.folds?.states.get(item.key) ?? card.initial(item, forms.cards(view.form, view.transcript?.meta.blocks)) }
		let rows = queued ? frame.queuedRows(item as Item & { type: 'prompt' }, inbox.note(m!, tab || undefined, m!.id === view.transcript?.queueHold), cols, session, look) : frame.itemRows(item, cols, session, undefined, undefined, undefined, [], '', look)
		let edge = queued ? ansi.paint('', itemView.itemStyle(item), cols) : undefined
		let joined = edge !== undefined && stacked === edge
		if (stacked && !joined) lines.push(stacked)
		if (rows.length && !joined) lines.push('')
		if (edge && !joined) lines.push(edge)
		stacked = edge
		lines.push(...rows)
	}
	if (stacked) lines.push(stacked)
	// The chrome, built apart to know its height for the padding.
	let history = lines
	lines = []
	// Why the tab stopped, then a one-off notice, a rule between them.
	block(noticeView.messages(view.why, view.notice, view.noticeClearable, width), { fg: colors.log().fg! })
	// Below them, the chrome proper: tab bar, the prompt box between
	// two rules, then the help row. Its height depends only on the
	// prompt's rows, so nothing below the transcript jumps.
	let p = promptView.box(view.prompt, width, view.placeholder)
	let input = colors.input()
	let rule = (left: string, center = '') => ansi.sgr(input) + promptView.rule(cols, left, ansi.clean(center)) + ansi.UNCOLOR
	let over = view.tabs?.list.length ? tabBar.overRow(view.tabs.list, view.tabs.focused, cols) : undefined
	if (over !== undefined) lines.push(over)
	else lines.push('')
	let anchor = lines.length
	if (view.tabs?.list.length) lines.push(tabBar.row(view.tabs.list, view.tabs.focused, cols, view.tabs.lit ?? true, view.tabs.alt))
	lines.push(rule(p.above ? `↑${p.above}` : '', view.activity))
	let top = lines.length
	for (let r of p.rows) lines.push(ansi.paint(r, input, cols))
	lines.push(rule(p.below ? `↓${p.below}` : ''))
	lines.push(view.status ? statusRow.row(view.status, cols) : '')
	// Text near the box's height earns the resize hint (task 0nj).
	lines.push(...helpRow.rows(view, cols, !!view.prompt.text.trim() && p.total >= Math.max(1, p.limit - 2)))
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

// The unchanged transcript prefix, including originating tool identities.
type History = { look: string; items: Item[]; ends: number[]; tools: { at: number; id: string; key: string; name: string; title?: string; fold: Verbosity }[]; lines: string[] }

// A Bash call whose command still scrolls at `now`: redrawn every frame.
const scrolls = (item: Item, now: number | undefined): boolean => now !== undefined && item.type === 'tool' && item.name === 'bash' && bashCard.scrolling(item.input.command, now - Date.parse(item.ts ?? ''))

export const frame = { state: { rows: new WeakMap<Item, { key: string; rows: string[] }>(), peaks: new Map<string, number>(), padded: false, history: undefined as History | undefined, ordered: undefined as { src: Item[]; how: string; grouped: Item[]; at: Ordering } | undefined }, layout, build, itemRows, look, queuedRows, order: batchOrder.order, promptWidth, scrolls }
