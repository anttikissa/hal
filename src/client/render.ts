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

import { ansi } from './ansi.ts'
import { frame, type Frame, type View } from './frame.ts'
import { terminal } from './terminal.ts'

export interface Output {
	write(s: string): void
	size(): { rows: number; cols: number }
}

interface RenderState {
	out: Output | null
	view: View
	/** The frame lines painted last; [] before the first paint or after park. */
	prev: string[]
	cursorRow: number
	fullscreen: boolean
	/** The tab painted last. */
	tab: string | undefined
	/** Parked for the shell (suspend, quit); only a forced draw paints. */
	parked: boolean
	timer: ReturnType<typeof setTimeout> | null
	dirty: boolean
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
		cursorRow: 0,
		fullscreen: false,
		tab: undefined,
		parked: false,
		timer: null,
		dirty: false,
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

// Rows as written: CRLF between them, none after a row that flows on.
function join(lines: string[]): string {
	return lines.map((l, i) => (flows(l) ? l.slice(0, -ansi.FLOW.length) : i < lines.length - 1 ? l + '\r\n' : l)).join('')
}

// Clear screen and scrollback, write the whole frame. The cursor ends
// on its last row.
function canonical(lines: string[]): string {
	return CLEAR_ALL + join(lines)
}

/**
 * The bytes that turn the terminal from the last painted frame into
 * `next`, with `rows` terminal rows. Updates the state as if written.
 */
function paint(next: Frame, rows: number, force = false): string {
	let st = render.state
	let prev = st.prev
	let lines = next.lines
	let wasFull = st.fullscreen
	// The last written row, where the cursor is after the body below.
	let row: number
	let body: string
	if (force && !wasFull && st.cursorRow >= rows) {
		// Our top is out of reach (the terminal shrank): no clean
		// repaint in place is possible any more.
		st.fullscreen = wasFull = true
	}
	if (force && wasFull) {
		body = canonical(lines)
		row = lines.length - 1
	} else if (force || !prev.length) {
		// Grow mode, or the first paint: from the top of our frame (the
		// cursor, on a first paint) clear down and write everything.
		body = '\r' + move(st.cursorRow, 0) + `${CSI}J` + join(lines)
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
			return out
		}
		let writableTop = Math.max(0, prev.length - rows)
		if (wasFull && (first < writableTop || lines.length < prev.length)) {
			body = canonical(lines)
			row = lines.length - 1
		} else if (first >= lines.length) {
			// Only rows at the end went away.
			body = move(st.cursorRow, first) + `\r${CSI}J`
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
				parts.push(join(lines.slice(i, end + 1)))
				at = i = end
			}
			row = at
			if (lines.length < prev.length) {
				// Erase the leftover rows below. CSI B, not CRLF: at the
				// bottom of the screen CRLF would scroll in a blank row.
				parts.push(move(at, lines.length - 1), `\r${CSI}1B${CSI}J`)
				row = lines.length
			}
			body = parts.join('')
		}
	}
	if (lines.length > rows) st.fullscreen = true
	st.prev = lines
	st.cursorRow = next.cursor.row
	return SYNC_ON + HIDE_CURSOR + body + move(row, next.cursor.row) + render.column(next.cursor.col) + SHOW_CURSOR + SYNC_OFF
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
function draw(force = false): void {
	let st = render.state
	if (!st.out || (st.parked && !force)) return
	st.parked = false
	let { rows, cols } = st.out.size()
	// Two or more tabs means full mode for good, from the first paint
	// that sees them: a restart on tab 2 then clears what the last run
	// left on screen instead of painting under it.
	if (!st.fullscreen && (st.view.tabs?.list.length ?? 0) > 1) st.fullscreen = force = true
	let tab = st.view.tabs?.focused
	if (tab !== undefined) {
		if (st.tab !== undefined && st.tab !== tab) st.fullscreen = force = true
		st.tab = tab
	}
	// A full redraw drops what kept blocks from shrinking (task fn), and
	// every laid-out row, so all repaint in the current colours (a
	// plugin's theme, task an).
	if (force) {
		frame.state.rows = new WeakMap()
		frame.state.peaks.clear()
		frame.state.history = undefined
	}
	let next = frame.build(st.view, cols, rows, st.fullscreen)
	// The modal's list moves only as far as it must from where it was.
	if (st.view.modal && next.modalScroll !== undefined) st.view.modal.scroll = next.modalScroll
	// So does the prompt box.
	st.view.prompt.scroll = next.promptScroll
	st.out.write(render.paint(next, rows, force))
	render.painted(st.view)
}

/**
 * Paint soon: at once if nothing was painted in the last frameMs, else
 * once when that time is up, however many requests came in between. A
 * stream of events can then never starve keyboard input.
 */
function request(): void {
	let st = render.state
	if (st.timer) {
		st.dirty = true
		return
	}
	render.draw()
	st.timer = setTimeout(() => {
		st.timer = null
		if (!st.dirty) return
		st.dirty = false
		render.request()
	}, render.frameMs())
}

/** Show a new view (transcript and prompt). */
function show(view: View): void {
	render.state.view = view
	render.request()
}

/**
 * Move the cursor to a fresh line below the frame and forget the frame,
 * so the shell (or the next paint) starts there. Never clears.
 */
function park(): void {
	let st = render.state
	if (!st.out || st.parked) return
	st.parked = true
	if (st.prev.length) st.out.write(move(st.cursorRow, st.prev.length - 1) + '\r\n' + SHOW_CURSOR)
	st.prev = []
	st.cursorRow = 0
}

/** Paint through the terminal from now on. Idempotent. */
function init(out: Output | null = terminal.state.io): void {
	if (render.state.out || !out) return
	render.state.out = out
	// Never while suspended: the shell has the terminal (a plugin's
	// onChange may call it any time).
	terminal.redraw = () => void (terminal.state.suspended || render.draw(true))
	terminal.onResize = () => render.draw(true)
	terminal.park = () => render.park()
}

/** Forget everything (tests). */
function reset(): void {
	if (render.state.timer) clearTimeout(render.state.timer)
	render.state = createState()
	frame.state.peaks.clear()
	frame.state.history = undefined
}

export const render = {
	state: createState(),
	/** Minimum time between two paints. */
	frameMs: () => 16,
	/** Told every view painted (main.ts waits for the first tab's). */
	painted: (_view: View): void => {},
	paint,
	column,
	draw,
	request,
	show,
	park,
	init,
	reset,
}
