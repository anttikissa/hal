// Lays out the transcript's items into terminal rows for the frame
// (frame.ts), reusing the rows of items unchanged since the last frame
// and slicing a long history across frames (task 7j).

import { bashResult } from '../common/bash-result.ts'
import { card, type Verbosity } from '../common/card.ts'
import { forms } from '../common/forms.ts'
import { promptChanges } from '../common/prompt-changes.ts'
import { settings } from '../common/settings.ts'
import { titles } from '../common/titles.ts'
import { toolDetails } from '../common/tool-details.ts'
import { transcript, type Item } from '../common/transcript.ts'
import { ansi } from './ansi.ts'
import { batchOrder, type Ordering } from './batch-order.ts'
import { formView } from './form-view.ts'
import { frame, type Frame, type View } from './frame.ts'
import { itemView, type Look } from './item-view.ts'
import { toolView } from './tool-view.ts'
import { water } from './water.ts'

// `items`/`ends`: the items laid out and the row each ends at, so a
// row can be traced to its block (render.clear's reasons, task e4c).
export type Past = {
	lines: string[]
	items?: Item[]
	ends?: number[]
	formCursor?: Frame['cursor']
	tick?: { row: number; labeled: string; plain: string }
}

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
	let src = view.transcript ? transcript.shown(view.transcript) : [],
		memo = frameLayout.state.ordered,
		how = `${session} ${src.length}`
	if (!save) memo = { src, how, grouped: [], at: { i: 0, out: frame.order(promptChanges.group(src)) } }
	else if (memo?.src !== src || memo.how !== how)
		memo = { src, how, grouped: promptChanges.group(src), at: { i: 0, out: [] } }
	if (memo.at.i < memo.grouped.length) memo.at = frame.order(memo.grouped, deadline, memo.at)
	if (save) frameLayout.state.ordered = memo
	if (memo.at.i < memo.grouped.length) return undefined
	let items = memo.at.out
	// The item that streams: the last but the open question below it.
	let streaming = items.findLast((item) => item.type !== 'question' || item.id !== view.form?.id)
	let calls = new Map<string, string>()
	let toolCalls = new Map<string, NonNullable<Look['call']>>()
	let backgroundCalls: Map<string, Item & { type: 'tool' }> | undefined
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
	let kept = frameLayout.state.history
	let start = 0
	// A question can become active without its transcript item changing
	// (the blocked-state event follows the question). Never reuse its
	// inactive rows while the form is taking keys.
	// A call's title shows its result's status, or its running time.
	if (kept?.look === look)
		while (start < kept.items.length && items[start] === kept.items[start]) {
			let item = items[start]!
			let after = kept.items[start + 1] ?? kept.next
			if (item.type === 'question' && item.id === view.form?.id) break
			if (
				item.type === 'tool' &&
				(item.id === view.tick?.call || items[start + 1] !== after || frame.scrolls(item, view.now))
			)
				break
			if (item.type === 'tool-result' && items[start + 1] !== after) break
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
		if (save)
			frameLayout.state.history = {
				look,
				items: items.slice(0, stable),
				next: items[stable],
				ends: ends.slice(0, stable),
				tools,
				lines,
			}
	}
	let imageStart = start
	while (imageStart > 0 && items[imageStart - 1]?.type === 'image') imageStart--
	let imagePrompt = items[imageStart - 1]?.type === 'prompt'
	for (let i = start; i < items.length; i++) {
		// A call is laid out with its results: stopping between them would
		// lay the call out again next slice, forever if it outlasts one.
		if (stable === i && i > start && items[i]!.type !== 'tool-result' && performance.now() > deadline) {
			keep()
			return undefined
		}
		let item = items[i]!
		if (item.type !== 'image') imagePrompt = item.type === 'prompt'
		// Toggled here, or as the session starts its kind (task hyt); a
		// call fails with its result.
		let res = batchOrder.state.apart.has(item) ? undefined : items[i + 1],
			failed =
				item.type === 'tool' &&
				res?.type === 'tool-result' &&
				res.id === item.id &&
				card.failed(res, item.name === 'bash')
		let fold =
			item.type === 'tool-result'
				? (callFolds.get(item.id) ?? 'short')
				: frameLayout.fold(view, item, card.initial(item, blocks, failed))
		if (item.type === 'tool') callFolds.set(item.id, fold)
		let look: Look = { fold }
		if (item.type === 'tool') {
			let title = item.presentation?.title ?? toolDetails.headline(item.name, item.input).text
			toolCalls.set(item.id, { key: item.key, name: item.name, title, ts: item.ts })
			tools.push({ at: i, id: item.id, key: item.key, name: item.name, title, ts: item.ts, fold })
			if (item.name === 'bash') calls.set(item.id, item.key)
		} else if (item.type === 'tool-result') {
			look.call = toolCalls.get(item.id)
			if (look.call) look.style = itemView.itemStyle(item, look.call.name)
		}
		let background = bashResult.background(item)
		if (background) {
			backgroundCalls ??= new Map(
				src.flatMap((i) => (i.type === 'tool' && i.name === 'bash' ? [[i.key, i] as const] : [])),
			)
			look.background = backgroundCalls.get(background.replace(/^t/, ''))
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
			let streams = item === streaming && view.hal?.at === 'stream'
			// Adjacent results continue their call's card without a reference or gap.
			let tool: string | undefined
			if (item.type === 'tool-result')
				for (let j = i - 1; j >= 0; j--) {
					let prev = items[j]!
					if ((prev.type !== 'tool' && prev.type !== 'tool-result') || prev.id !== item.id) break
					if (prev.type === 'tool' && batchOrder.state.apart.has(prev)) break
					if (prev.type === 'tool') {
						tool = prev.name
						look.head = toolView.heads.get(prev)
						if (toolDetails.fullCommand(prev.name, prev.input)) look.full = true
					}
				}
			let images: Item[] = []
			if (item.type === 'prompt') for (let j = i + 1; items[j]?.type === 'image'; j++) images.push(items[j]!)
			let merged = item.type === 'image' && imagePrompt
			// Status and the reserved spinner cell keep call headers stable
			// (task hyt); a call whose output is drawn below shows ↓ there.
			let ticks = item.type === 'tool' && item.id === view.tick?.call
			let live = ticks || (streams && !!view.tick && view.tick.call === undefined)
			let cell =
				item.type === 'tool' || item.type === 'thinking' || item.type === 'text'
					? live
						? view.tick!.spin
						: batchOrder.state.apart.has(item)
							? ansi.quiet('↓', itemView.itemStyle(item))
							: ''
					: ''
			if (item.type === 'tool' && res?.type === 'tool-result' && res.id === item.id) look.result = res
			if (item.type === 'tool' && !item.presentation && !look.result?.presentation) {
				let h = toolDetails.headline(item.name, item.input, look.result?.output)
				if (h.mark === 'wait') look.wait = toolDetails.waiting(h.text, session ?? '', src, view.tabs?.list)
			}
			let limit = item.type === 'tool' ? toolDetails.limit(item.name, item.input) : undefined
			if (live) look.status = toolView.status(undefined, view.tick!.label, itemView.itemStyle(item), limit)
			else if (
				look.result &&
				!(fold === 'long' && titles.resultTime(item.ts, look.result.ts) && bashResult.trim(look.result.output))
			)
				look.status = toolView.resultStatus(
					look.result,
					item.type === 'tool' && item.name === 'bash',
					itemView.itemStyle(item),
					limit,
					fold === 'short' && settings.shortRows() === 1,
				)
			if (item.type === 'tool' && item.name === 'bash' && view.now !== undefined) look.now = view.now
			if (cell) look.status = look.status ? `${look.status} ${cell}` : cell
			frameLayout.streamLook(item, look, fold, screenRows)
			look = frame.look(item, look)
			let rows = merged
				? []
				: frame.itemRows(item, cols, session, streams ? view.hal : undefined, calls, tool, images, look.status, look)
			let natural = rows.length
			rows = water.high(frame.state.peaks, rows, item, cols, session, streams)
			if (rows.length > natural) frame.state.padded = true
			let region = item.type === 'tool-result' && !tool ? batchOrder.state.below.get(item) : undefined
			if (region && below?.key !== region) below = { key: region, start: lines.length }
			// An attached result follows its call's last row: both padding rows go.
			if (tool && rows.length && lines.length && drawn?.pad !== false) {
				lines.pop()
				if (!Bun.stripANSI(rows[0]!).trim()) rows = rows.slice(1)
			} else if (rows.length && look.gap !== false && (lines.length || Bun.stripANSI(rows[0]!).trim())) lines.push('')
			if (rows.length) drawn = look
			for (let r of rows) lines.push(r)
			if (item.type === 'tool' && !batchOrder.state.apart.has(item))
				callCard = { id: item.id, key: item.key, start: lines.length - rows.length }
			let next = items[i + 1]
			// A split batch's output region never shrinks either: its live
			// rows give way to the results (task 5gn).
			if (region && below && !(next && batchOrder.state.below.get(next) === region)) {
				let natural = lines.length
				water.card(
					frame.state.peaks,
					lines,
					below.start,
					`${cols} ${screenRows} ${session} below ${region} ${look.fold ?? ''}`,
					look.style,
					cols,
				)
				if (lines.length > natural) frame.state.padded = true
				below = undefined
			}
			if (
				callCard &&
				(item.type === 'tool' || item.type === 'tool-result') &&
				item.id === callCard.id &&
				!(next?.type === 'tool-result' && next.id === callCard.id)
			) {
				let natural = lines.length
				water.card(
					frame.state.peaks,
					lines,
					callCard.start,
					`${cols} ${screenRows} ${session} call ${callCard.key} ${look.fold ?? ''}${look.full ? 'full' : ''}`,
					itemView.itemStyle(item, tool),
					cols,
				)
				if (lines.length > natural) frame.state.padded = true
				callCard = undefined
			}
			if (live) {
				let plain = frame.itemRows(item, cols, session, streams ? view.hal : undefined, calls, tool, images, '', look)
				let k = rows.findIndex((r, j) => r !== plain[j])
				if (k >= 0 && rows.length === plain.length)
					tick = { row: lines.length - rows.length + k, labeled: rows[k]!, plain: plain[k]! }
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

// The unchanged transcript prefix, including originating tool identities.
type History = {
	look: string
	items: Item[]
	/** The item after `items` when they were laid out, if any: a slice
	 * that ends after a call still knows the call's results were there. */
	next: Item | undefined
	ends: number[]
	tools: (NonNullable<Look['call']> & { at: number; id: string; fold: Verbosity })[]
	lines: string[]
}

// A Bash card's '&' mark and, while it streams open, its bounded tail;
// also for a running job's card at the bottom (task 6nn).
function streamLook(item: Item, look: Look, fold: Verbosity, screenRows: number): void {
	if (item.type === 'tool' && item.name === 'bash' && item.input.background === true)
		look.status = look.status?.trimEnd() ? `${look.status.trimEnd()} &` : '&'
	if (
		fold === 'long' &&
		((item.type === 'tool' && item.partial !== undefined && !look.result) ||
			(item.type === 'tool-result' && (item as Item & { live?: boolean }).live))
	)
		look.streamRows = Math.max(1, Math.floor(screenRows / 2) - 10)
}

// How card `item` shows: toggled here, else a job's result as its
// streaming card was (task 6nn: a card never shrinks as its job ends),
// else `initial`. For transcript and waiting cards alike.
function fold(view: View, item: Item, initial: Verbosity): Verbosity {
	return view.folds?.states.get(item.key) ?? view.folds?.states.get(bashResult.job(item) ?? '') ?? initial
}

export const frameLayout = {
	state: {
		history: undefined as History | undefined,
		ordered: undefined as { src: Item[]; how: string; grouped: Item[]; at: Ordering } | undefined,
	},
	layout,
	streamLook,
	fold,
}
