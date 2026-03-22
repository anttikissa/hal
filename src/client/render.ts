// Terminal renderer for one logical "app frame" (content + chrome + prompt).
// See docs/terminal.md for the behavior contract.
//
// This renderer keeps the full logical frame in memory, but it only mutates
// lines that are currently visible in the terminal viewport.
//
// Why: rows above the viewport are already in scrollback. Repainting those rows
// duplicates history or creates gaps in terminal scrollback.
const ESC = "\x1b"
const RESET = `${ESC}[0m`
const SYNC_START = `${ESC}[?2026h`
const SYNC_END = `${ESC}[?2026l`
const CLEAR_LINE = `${ESC}[2K`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`

function moveUp(n: number): string {
	return n > 0 ? `${ESC}[${n}A` : ""
}

function moveBetweenRows(from: number, to: number): string {
	const delta = to - from
	if (delta > 0) return `${ESC}[${delta}B`
	if (delta < 0) return `${ESC}[${-delta}A`
	return ""
}

let prevLines: string[] = []

export interface RenderMetrics {
	contentLines: number
	padding: number
	totalLines: number
	maxContentHeight: number
}

export interface RenderState {
	blocks: string[]
	allTabBlockCounts: number[]
	tabs: string
	separator: string
	prompt: string
	cursorCol: number
}

export interface RenderOptions {
	force?: boolean
}

function countLines(text: string): number {
	return text.split('\n').length
}

function splitContentLines(blocks: string[]): string[] {
	const lines: string[] = []
	for (const block of blocks) lines.push(...block.split('\n'))
	return lines
}

// Metrics are used by both debug output and frame layout.
// We cap padding by visible content height so short tabs align with tall tabs
// without growing blank lines into scrollback once content exceeds viewport.
export function getRenderMetrics(
	state: Pick<RenderState, 'blocks' | 'allTabBlockCounts' | 'tabs' | 'prompt'>,
	separatorLineCount: number,
): RenderMetrics {
	const chromeLines =
		countLines(state.tabs) + separatorLineCount + countLines(state.prompt)
	const visibleContentHeight = Math.max(
		0,
		(process.stdout.rows ?? Number.POSITIVE_INFINITY) - chromeLines,
	)
	const maxContentHeight = Math.max(0, ...state.allTabBlockCounts)
	const contentLines = splitContentLines(state.blocks).length
	const paddedContentHeight = Math.min(maxContentHeight, visibleContentHeight)
	const padding = Math.max(0, paddedContentHeight - contentLines)
	return {
		contentLines,
		padding,
		totalLines: contentLines + padding + chromeLines,
		maxContentHeight,
	}
}

function computeLines(state: RenderState): string[] {
	const actualContentLines = splitContentLines(state.blocks)
	const metrics = getRenderMetrics(state, countLines(state.separator))
	const lines = [...Array.from({ length: metrics.padding }, () => ''), ...actualContentLines]

	// Keep blank space above short tabs so visible lines stay near the prompt.
	lines.push(...state.tabs.split('\n'))
	lines.push(...state.separator.split('\n'))
	lines.push(...state.prompt.split('\n'))
	return lines
}

function getVisibleLines(lines: string[], rows: number): string[] {
	const viewportTop = Math.max(0, lines.length - rows)
	return lines.slice(viewportTop)
}

function findChangedRange(prev: string[], next: string[]): { start: number, end: number } | null {
	let start = -1
	let end = -1
	const maxLen = Math.max(prev.length, next.length)
	for (let i = 0; i < maxLen; i++) {
		if ((prev[i] ?? '') !== (next[i] ?? '')) {
			if (start === -1) start = i
			end = i
		}
	}
	if (start === -1) return null
	return { start, end }
}

function writeLineRange(out: string[], lines: string[], start: number, end: number): void {
	if (end < start) return
	for (let i = start; i <= end; i++) {
		out.push(CLEAR_LINE + RESET + lines[i]!)
		if (i < end) out.push('\r\n')
	}
}

/**
 * Main render function.
 *
 * Flow:
 * 1) build full logical frame
 * 2) project it to the visible viewport
 * 3) diff/repaint only visible rows (or repaint visible rows when forced)
 * 4) clear stale rows below the new viewport when visible height shrinks
 * 5) restore cursor to prompt input column
 */
export function render(state: RenderState, options: RenderOptions = {}): void {
	const lines = computeLines(state)
	const out: string[] = []
	const screenRows = process.stdout.rows ?? Number.POSITIVE_INFINITY
	const prevVisible = getVisibleLines(prevLines, screenRows)
	const nextVisible = getVisibleLines(lines, screenRows)

	out.push(SYNC_START)
	out.push(HIDE_CURSOR)

	// Cursor row in viewport coordinates (0 = top row of viewport content).
	// We end every render on the prompt row, so on entry this starts at the
	// previous prompt row.
	let cursorRow = prevVisible.length - 1
	let didRender = false

	if (prevLines.length === 0 || options.force) {
		if (prevLines.length > 0) {
			// On a forced redraw we are currently on the old prompt row. Move to the
			// top of the old visible area before repainting the new visible viewport.
			out.push(`\r${moveUp(cursorRow)}`)
			cursorRow = 0
		}
		writeLineRange(out, nextVisible, 0, nextVisible.length - 1)
		cursorRow = nextVisible.length - 1
		didRender = nextVisible.length > 0
	} else {
		const changed = findChangedRange(prevVisible, nextVisible)
		if (changed) {
			// Carriage return first so clear+rewrite always starts at column 0.
			out.push(`\r${moveBetweenRows(cursorRow, changed.start)}`)
			cursorRow = changed.start

			const renderEnd = Math.min(changed.end, nextVisible.length - 1)
			if (renderEnd >= changed.start) {
				writeLineRange(out, nextVisible, changed.start, renderEnd)
				cursorRow = renderEnd
				didRender = true
			}
		}
	}

	if (nextVisible.length < prevVisible.length) {
		// The old frame had more visible rows than the new frame. Clear once from
		// the new last row to terminal end, so stale lines disappear.
		const newLastRow = Math.max(0, nextVisible.length - 1)
		out.push(`\r${moveBetweenRows(cursorRow, newLastRow)}${ESC}[J`)
		cursorRow = newLastRow
		didRender = true
	}

	if (didRender) {
		const promptRow = Math.max(0, nextVisible.length - 1)
		out.push(moveBetweenRows(cursorRow, promptRow))
	}

	prevLines = lines
	out.push(`\r${ESC}[${state.cursorCol}C`)
	out.push(SHOW_CURSOR)
	out.push(SYNC_END)
	process.stdout.write(out.join(''))
}

export function clearFrame(): void {
	if (prevLines.length === 0) return
	const rows = process.stdout.rows ?? prevLines.length
	const visibleLines = Math.min(prevLines.length, rows)
	process.stdout.write(`\r${moveUp(visibleLines - 1)}${ESC}[J`)
	prevLines = []
}
