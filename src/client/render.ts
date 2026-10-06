// Gets frames onto the terminal like a REPL: the first paint starts at
// the cursor without clearing, later paints rewrite only the rows that
// changed, and quitting leaves the last frame on screen. The rules
// are in tasks/cc/terminal.md; the short version:
//
// - Every frame holds all history. Rows that scroll off the top enter
//   the terminal's scrollback, which is immutable: cursor-up clamps at
//   the top of the screen, and only CSI 3J (all of it) clears it.
// - Grow mode: the frame has always fitted on the screen, so a full
//   repaint moves to its top and clears down; shell output above Hal
//   survives.
// - Full mode, entered one-way when a frame first outgrows the screen
//   or there are two or more tabs (canonically: scrollback is the
//   shown tab only):
//   when a changed row is already in scrollback, or the frame shrinks,
//   there is no correct in-place update, so the canonical repaint
//   clears screen and scrollback and writes the whole frame again.
// - state.cursorRow always says which frame row the cursor is on.
// - Every frame line is at most one terminal row (frame.ts wraps), so
//   frame rows and terminal rows are the same thing. Rows ending in
//   ansi.FLOW continue on the next (a long URL): they are written with
//   no CRLF between, so the terminal soft-wraps them into one line, and
//   such a chain is always rewritten whole, from its first row.
// - Every erase of rows the paint does not rewrite in place goes
//   through render.clear(reason), and nothing else erases (task e4c):
//   a plugin observes each one, with why, by hooking it.

import { titles } from '../common/titles.ts'
import { ansi } from './ansi.ts'
import { frame, type Frame, type Past, type View } from './frame.ts'
import { terminal } from './terminal.ts'

export interface Output {
	write(s: string): void
	/** Write what `make` returns when the bytes before it are out, so a
	 * big repaint is joined and encoded a piece at a time (task 7j). */
	defer?(make: () => string): void
	size(): { rows: number; cols: number }
}

/**
 * Why rows are erased (task e4c). `kind`: 'all' clears screen and
 * scrollback, which snaps a scrolled-up terminal to the bottom; 'down'
 * clears from the frame's top row down (scrollback untouched); 'below'
 * erases rows past the frame's new end; 'row' erases the help row for
 * the shell. `blocks`: the parts whose row counts changed, as
 * '#t239 (tool-result)', 'waiting messages' or 'the prompt area'.
 * Holds no transcript text.
 */
export interface ClearReason {
	kind: 'all' | 'down' | 'below' | 'row'
	cause: 'forced' | 'first paint' | 'shrink' | 'scrollback edit' | 'park'
	trigger?: string
	rows: { before: number; after: number; screen: number }
	firstChanged?: number
	writableTop?: number
	/** The block holding the first changed row, in the last frame. */
	changedBlock?: string
	blocks?: { block: string; before: number; after: number }[]
	text: string
}

// Bytes to write: a string, or a piece of a big one made when written.
type Part = string | (() => string)

interface RenderState {
	out: Output | null
	view: View
	/** The frame lines painted last; [] before the first paint or after park. */
	prev: string[]
	/** Where the last frame's blocks were, for clear reasons. */
	shape: Shape | undefined
	cursorRow: number
	fullscreen: boolean
	/** The tab painted last. */
	tab: string | undefined
	/** Parked for the shell (suspend, quit); only a forced draw paints. */
	parked: boolean
	timer: ReturnType<typeof setTimeout> | null
	dirty: boolean
	/** The items' rows painted last and whose tab they are: shown again
	 * while a long history is laid out in slices. */
	past: { session: string | undefined; past: Past } | undefined
	/** The next slice of that layout. */
	slicing: ReturnType<typeof setTimeout> | null
	/** A blank row goes above the first paint if that frame fits the
	 * screen (task hd); main.ts sets it on a terminal. */
	gap: boolean
}

const CSI = '\x1b['
const SYNC_ON = `${CSI}?2026h`
const SYNC_OFF = `${CSI}?2026l`
const HIDE_CURSOR = `${CSI}?25l`
const SHOW_CURSOR = `${CSI}?25h`
const CLEAR_ALL = `${CSI}2J${CSI}H${CSI}3J`

function createState(): RenderState {
	return {
		out: null,
		view: { prompt: { text: '', cursor: 0 } },
		prev: [],
		shape: undefined,
		cursorRow: 0,
		fullscreen: false,
		tab: undefined,
		parked: false,
		timer: null,
		dirty: false,
		past: undefined,
		slicing: null,
		gap: false,
	}
}

function move(from: number, to: number): string {
	if (to > from) return `${CSI}${to - from}B`
	if (to < from) return `${CSI}${from - to}A`
	return ''
}

// Whether frame row `line` continues on the next.
function flows(line: string | undefined): boolean {
	return !!line?.endsWith(ansi.FLOW)
}

// Rows from..to-1 as written: CRLF between them, none after a row that
// flows on.
function join(lines: string[], from = 0, to = lines.length): string {
	let out = ''
	for (let i = from; i < to; i++) {
		let l = lines[i]!
		out += flows(l) ? l.slice(0, -ansi.FLOW.length) : i < to - 1 ? l + '\r\n' : l
	}
	return out
}

// All the rows, joined a piece at a time as they are written.
function rowParts(lines: string[]): Part[] {
	let n = render.chunkRows
	if (lines.length <= n) return [join(lines)]
	let parts: Part[] = []
	for (let a = 0; a < lines.length; a += n) {
		let b = Math.min(lines.length, a + n)
		parts.push(() => join(lines, a, b) + (b < lines.length && !flows(lines[b - 1]) ? '\r\n' : ''))
	}
	return parts
}

// Clear screen and scrollback, write the whole frame. The cursor ends
// on its last row.
function canonical(lines: string[], reason: ClearReason): Part[] {
	return [render.clear(reason), ...rowParts(lines)]
}

/** The erase sequence for `reason`; the one place that erases rows. */
function clear(reason: ClearReason): string {
	return reason.kind === 'all' ? CLEAR_ALL : reason.kind === 'row' ? `${CSI}2K` : `${CSI}J`
}

type Shape = { length: number; history: number; items?: Frame['items']; ends?: number[] }

// The part of frame `f` that row `row` belongs to.
function blockAt(f: Shape, row: number): string {
	let ends = f.ends ?? []
	if (row < (ends.at(-1) ?? 0)) {
		let lo = 0
		for (let hi = ends.length - 1; lo < hi; ) {
			let mid = (lo + hi) >> 1
			if (ends[mid]! > row) hi = mid
			else lo = mid + 1
		}
		let item = f.items![lo]!
		return `#${titles.blockId(item)} (${item.type})`
	}
	return row < f.history ? 'waiting messages' : 'the prompt area'
}

// Rows per part of frame `f`.
function sizes(f: Shape): Map<string, number> {
	let m = new Map<string, number>()
	let add = (k: string, n: number) => n && m.set(k, (m.get(k) ?? 0) + n)
	let ends = f.ends ?? []
	ends.forEach((end, i) => add(blockAt(f, end - 1), end - (i ? ends[i - 1]! : 0)))
	add('waiting messages', f.history - (ends.at(-1) ?? 0))
	add('the prompt area', f.length - f.history)
	return m
}

// The parts whose row counts differ between two frames, biggest
// shrink first, at most 5.
function changes(a: Shape | undefined, b: Shape): NonNullable<ClearReason['blocks']> {
	if (!a) return []
	let x = sizes(a), y = sizes(b)
	let out = [...new Set([...x.keys(), ...y.keys()])].map((block) => ({ block, before: x.get(block) ?? 0, after: y.get(block) ?? 0 })).filter((c) => c.before !== c.after)
	return out.sort((p, q) => p.after - p.before - (q.after - q.before)).slice(0, 5)
}

function said(blocks: NonNullable<ClearReason['blocks']>): string {
	return blocks.length ? `: ${blocks.map((c) => `${c.block} ${c.before} → ${c.after} rows`).join(', ')}` : ''
}

// Parts made into one string (tests, small frames).
function text(parts: Part[]): string {
	return parts.map((p) => (typeof p === 'string' ? p : p())).join('')
}

/**
 * The bytes that turn the terminal from the last painted frame into
 * `next`, with `rows` terminal rows. Updates the state as if written.
 */
function paint(next: Frame, rows: number, force = false, trigger?: string): string {
	return text(render.paintParts(next, rows, force, trigger))
}

function paintParts(next: Frame, rows: number, force = false, trigger = 'a redraw'): Part[] {
	let st = render.state
	let prev = st.prev
	let lines = next.lines
	let shape: Shape = { length: lines.length, history: next.history, items: next.items, ends: next.ends }
	let size = { before: prev.length, after: lines.length, screen: rows }
	let wasFull = st.fullscreen
	// Off the shell's output above, unless the frame fills the screen.
	let gap = st.gap && !prev.length && lines.length < rows ? '\r\n' : ''
	st.gap = false
	// The last written row, where the cursor is after the body below.
	let row: number
	let body: Part[]
	if (force && !wasFull && st.cursorRow >= rows) {
		// Our top is out of reach (the terminal shrank): no clean
		// repaint in place is possible any more.
		st.fullscreen = wasFull = true
		trigger += ', with the frame top out of reach'
	}
	if (force && wasFull) {
		body = canonical(lines, { kind: 'all', cause: 'forced', trigger, rows: size, text: `Cleared screen and scrollback and repainted everything because of ${trigger}.` })
		row = lines.length - 1
	} else if (force || !prev.length) {
		// Grow mode, or the first paint: from the top of our frame (the
		// cursor, on a first paint) clear down and write everything.
		let reason: ClearReason = force
			? { kind: 'down', cause: 'forced', trigger, rows: size, text: `Repainted the frame from its top (scrollback untouched) because of ${trigger}.` }
			: { kind: 'down', cause: 'first paint', rows: size, text: 'Cleared below the cursor for the first paint.' }
		body = [gap + '\r' + move(st.cursorRow, 0) + render.clear(reason), ...rowParts(lines)]
		row = lines.length - 1
	} else {
		let first = 0
		while (first < lines.length && first < prev.length && lines[first] === prev[first]) first++
		let same = first === lines.length && first === prev.length
		// A change inside a flowing chain rewrites it from its start.
		while (first > 0 && first < lines.length && flows(lines[first - 1])) first--
		if (same) {
			// Nothing changed but the cursor.
			let out = move(st.cursorRow, next.cursor.row) + render.column(next.cursor.col)
			st.cursorRow = next.cursor.row
			if (lines.length > rows) st.fullscreen = true
			st.shape = shape
			return [out]
		}
		let writableTop = Math.max(0, prev.length - rows)
		let shrank = (): ClearReason => {
			let blocks = changes(st.shape, shape)
			return { kind: 'below', cause: 'shrink', rows: size, firstChanged: first, blocks, text: `Erased ${prev.length - lines.length} rows below the frame's new end${said(blocks)}.` }
		}
		if (wasFull && (first < writableTop || lines.length < prev.length)) {
			let blocks = changes(st.shape, shape)
			let changedBlock = st.shape ? blockAt(st.shape, first) : undefined
			let reason: ClearReason =
				first < writableTop
					? { kind: 'all', cause: 'scrollback edit', rows: size, firstChanged: first, writableTop, changedBlock, blocks, text: `Row ${first}, in ${changedBlock ?? 'an unknown block'}, changed in scrollback (rows above ${writableTop} cannot be rewritten in place)${lines.length < prev.length ? ` and the frame shrank from ${prev.length} to ${lines.length} rows` : ''}, so Hal cleared screen and scrollback and repainted${said(blocks)}.` }
					: { kind: 'all', cause: 'shrink', rows: size, firstChanged: first, writableTop, changedBlock, blocks, text: `The frame shrank from ${prev.length} to ${lines.length} rows; a terminal cannot pull scrollback back onto the screen, so Hal cleared screen and scrollback and repainted${said(blocks)}.` }
			body = canonical(lines, reason)
			row = lines.length - 1
		} else if (first >= lines.length) {
			// Only rows at the end went away.
			body = [move(st.cursorRow, first) + '\r' + render.clear(shrank())]
			row = first
		} else {
			// Rewrite the rows that changed from the first change on (a
			// blink rewrites one row, not the frame); CRLF past the old
			// end scrolls new rows in naturally.
			let parts: string[] = []
			let at = st.cursorRow
			for (let i = first; i < lines.length; i++) {
				// A flowing chain, i..end, goes as one unit.
				let end = i
				while (end < lines.length - 1 && flows(lines[end])) end++
				let changed = false
				for (let k = i; k <= end; k++) if (k >= prev.length || lines[k] !== prev[k]) changed = true
				if (!changed) {
					i = end
					continue
				}
				// Appending: from the row above, which exists.
				if (i >= prev.length) parts.push(move(at, i - 1), `\r\n${CSI}2K`)
				else {
					parts.push(move(at, i), `\r${CSI}2K`)
					// Clear the chain's other old rows first: writing it
					// must not stop between them.
					let old = Math.min(end, prev.length - 1) - i
					if (old > 0) parts.push(`${CSI}B${CSI}2K`.repeat(old), move(i + old, i), '\r')
				}
				parts.push(join(lines, i, end + 1))
				at = i = end
			}
			row = at
			if (lines.length < prev.length) {
				// Erase the leftover rows below. CSI B, not CRLF: at the
				// bottom of the screen CRLF would scroll in a blank row.
				parts.push(move(at, lines.length - 1), `\r${CSI}1B` + render.clear(shrank()))
				row = lines.length
			}
			body = [parts.join('')]
		}
	}
	if (lines.length > rows) st.fullscreen = true
	st.prev = lines
	st.shape = shape
	st.cursorRow = next.cursor.row
	return [SYNC_ON + HIDE_CURSOR, ...body, move(row, next.cursor.row) + render.column(next.cursor.col) + SHOW_CURSOR + SYNC_OFF]
}

function column(col: number): string {
	return col > 0 ? `\r${CSI}${col + 1}G` : '\r'
}

/**
 * Paint the current view now. Force repaints everything (Ctrl-L, resize,
 * resume). Having two or more tabs enters full mode for good, and
 * showing another tab than last time repaints canonically: scrollback
 * holds only the tab shown.
 */
function draw(force = false, trigger?: string): void {
	let st = render.state
	if (terminal.state.external || !st.out || (st.parked && !force)) return
	st.parked = false
	let { rows, cols } = st.out.size()
	// Two or more tabs (startTabs until the host lists them) means full
	// mode for good, from the first paint: no inline frame first that a
	// clear then replaces, and a restart clears what the last run left.
	if (!st.fullscreen && (st.view.tabs?.list.length ?? render.startTabs) > 1) {
		st.fullscreen = force = true
		trigger = 'the first paint with two or more tabs'
	}
	let tab = st.view.tabs?.focused
	if (tab !== undefined) {
		if (st.tab !== undefined && st.tab !== tab) {
			st.fullscreen = force = true
			trigger = 'a tab switch'
		}
		st.tab = tab
	}
	// A full redraw drops what kept blocks from shrinking (task fn), and
	// every laid-out row, so all repaint in the current colors (a
	// plugin's theme, task an).
	if (force) {
		frame.state.rows = new WeakMap()
		frame.state.peaks.clear()
		frame.state.history = undefined
		st.past = undefined
	}
	// A long history is laid out a slice at a time (task 7j). Until it
	// is, the tab's rows painted last stay; a tab not painted since the
	// last full redraw shows its last screenful of items meanwhile.
	let session = st.view.transcript?.meta.id
	let past = frame.layout(st.view, cols, performance.now() + render.sliceMs, true, rows)
	if (!past) {
		render.later()
		past = st.past && st.past.session === session ? st.past.past : frame.layout(render.tail(st.view, cols, rows), cols, Infinity, false, rows)!
	}
	st.past = { session, past }
	let next = frame.build(st.view, cols, rows, st.fullscreen, past)
	// The modal's list moves only as far as it must from where it was.
	if (st.view.modal && next.modalScroll !== undefined) st.view.modal.scroll = next.modalScroll
	// So does the prompt box.
	st.view.prompt.scroll = next.promptScroll
	let out = st.out
	let pending = ''
	for (let p of render.paintParts(next, rows, force, trigger)) {
		if (typeof p === 'string') pending += p
		else if (out.defer) {
			if (pending) out.write(pending)
			pending = ''
			out.defer(p)
		} else pending += p()
	}
	if (pending) out.write(pending)
	render.painted(st.view)
}

// `view` with only the last items of its transcript, about a screen of
// rows `cols` wide.
function tail(view: View, cols: number, rows: number): View {
	let t = view.transcript
	if (!t) return view
	let at = t.items.length
	for (let n = 0; at > 0 && n < rows; ) n += frame.itemRows(t.items[--at]!, cols, t.meta.id).length + 1
	return { ...view, transcript: { ...t, items: t.items.slice(at) } }
}

// Lays out the next slice of the history in a task of its own, and
// paints once it is all laid out.
function later(): void {
	let st = render.state
	if (st.slicing) return
	st.slicing = setTimeout(() => {
		st.slicing = null
		if (!st.out) return
		if (frame.layout(st.view, st.out.size().cols, performance.now() + render.sliceMs, true, st.out.size().rows)) render.request()
		else render.later()
	}, 0)
}

/**
 * Paint soon: at the end of this task if nothing was painted in the
 * last frameMs, else once when that time is up, however many requests
 * came in between. A stream of events can then never starve keyboard
 * input. The paint waits for the task's end because the host delivers
 * one change as several events in a row (a waiting message leaves the
 * inbox, then arrives as a prompt): painting between them would draw a
 * frame shorter than both, which clears scrollback in full mode.
 */
function request(): void {
	let st = render.state
	if (st.timer) {
		st.dirty = true
		return
	}
	queueMicrotask(() => {
		st.dirty = false
		render.draw()
	})
	st.timer = setTimeout(() => {
		st.timer = null
		if (!st.dirty) return
		st.dirty = false
		render.request()
	}, render.frameMs)
}

/** Show a new view (transcript and prompt). */
function show(view: View): void {
	render.state.view = view
	render.request()
}

/**
 * Erase the frame's last row (the help row), leave the cursor at its
 * start and forget the frame, so the shell prompt (or the next paint)
 * takes that row: nothing scrolls, and a restart repaints in place.
 * Clears nothing else.
 */
function park(): void {
	let st = render.state
	if (!st.out || st.parked) return
	st.parked = true
	let size = { before: st.prev.length, after: 0, screen: st.out.size().rows }
	if (st.prev.length) st.out.write(move(st.cursorRow, st.prev.length - 1) + '\r' + render.clear({ kind: 'row', cause: 'park', rows: size, text: 'Erased the help row so the shell prompt takes it (suspend or quit).' }) + SHOW_CURSOR)
	st.prev = []
	st.shape = undefined
	st.cursorRow = 0
}

/** Paint through the terminal from now on. Idempotent. */
function init(out: Output | null = terminal.state.io): void {
	if (render.state.out || !out) return
	render.state.out = out
	// Never while suspended: the shell has the terminal (a plugin's
	// onChange may call it any time).
	terminal.redraw = (trigger = 'a redraw request') => void (terminal.state.suspended || render.draw(true, trigger))
	terminal.onResize = () => render.draw(true, 'a terminal resize')
	terminal.park = () => render.park()
}

/** Forget everything (tests). */
function reset(): void {
	if (render.state.timer) clearTimeout(render.state.timer)
	if (render.state.slicing) clearTimeout(render.state.slicing)
	render.state = createState()
	frame.state.peaks.clear()
	frame.state.history = undefined
}

export const render = {
	state: createState(),
	/** Open tabs before the host says (the home's tabs file). */
	startTabs: 0,
	/** Minimum time between two paints. */
	frameMs: 16,
	/** How long a slice of history layout may run before yielding. */
	sliceMs: 4,
	/** Rows joined per piece of a big repaint. */
	chunkRows: 1000,
	/** Told every view painted (main.ts waits for the first tab's). */
	painted: (_view: View): void => {},
	paint,
	paintParts,
	clear,
	column,
	draw,
	tail,
	later,
	request,
	show,
	park,
	init,
	reset,
}
