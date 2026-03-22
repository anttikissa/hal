// Terminal renderer for one logical "app frame" (content + chrome + prompt).
// See docs/terminal.md for the behavior contract.
//
// This renderer keeps the full logical frame in memory, but it only mutates
// rows that are currently visible in the terminal viewport.
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
const ANSI_CSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

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

function stripAnsi(text: string): string {
	return text.replace(ANSI_CSI_PATTERN, '')
}

function countLineRows(line: string, cols: number): number {
	if (!Number.isFinite(cols) || cols <= 0) return 1
	const width = [...stripAnsi(line)].length
	return Math.max(1, Math.ceil(width / cols))
}

export function countTextRows(
	text: string,
	cols = process.stdout.columns ?? Number.POSITIVE_INFINITY,
): number {
	let rows = 0
	for (const line of text.split('\n')) rows += countLineRows(line, cols)
	return rows
}

function countRows(lines: string[], cols: number): number {
	let rows = 0
	for (const line of lines) rows += countLineRows(line, cols)
	return rows
}

function splitContentLines(blocks: string[]): string[] {
	const lines: string[] = []
	for (const block of blocks) lines.push(...block.split('\n'))
	return lines
}

function getRowStarts(lines: string[], cols: number): number[] {
	const starts: number[] = []
	let row = 0
	for (const line of lines) {
		starts.push(row)
		row += countLineRows(line, cols)
	}
	return starts
}

// Metrics are used by both debug output and frame layout.
// We cap padding by visible content height so short tabs align with tall tabs
// without growing blank lines into scrollback once content exceeds viewport.
export function getRenderMetrics(
	state: Pick<RenderState, 'blocks' | 'allTabBlockCounts' | 'tabs' | 'prompt'>,
	separatorLineCount: number,
): RenderMetrics {
	const cols = process.stdout.columns ?? Number.POSITIVE_INFINITY
	const chromeLines =
		countTextRows(state.tabs, cols) +
		separatorLineCount +
		countTextRows(state.prompt, cols)
	const visibleContentHeight = Math.max(
		0,
		(process.stdout.rows ?? Number.POSITIVE_INFINITY) - chromeLines,
	)
	const maxContentHeight = Math.max(0, ...state.allTabBlockCounts)
	const contentLines = countRows(splitContentLines(state.blocks), cols)
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
	const metrics = getRenderMetrics(state, countTextRows(state.separator))
	const lines = [...Array.from({ length: metrics.padding }, () => ''), ...actualContentLines]

	// Keep blank space above short tabs so visible lines stay near the prompt.
	lines.push(...state.tabs.split('\n'))
	lines.push(...state.separator.split('\n'))
	lines.push(...state.prompt.split('\n'))
	return lines
}

function getVisibleLines(lines: string[], rows: number, cols: number): string[] {
	if (!Number.isFinite(rows)) return [...lines]
	if (rows <= 0) return []

	const visible: string[] = []
	let usedRows = 0
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!
		const lineRows = countLineRows(line, cols)
		if (usedRows + lineRows > rows) {
			if (usedRows === 0) visible.unshift(line)
			break
		}
		visible.unshift(line)
		usedRows += lineRows
	}
	return visible
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
 * 2) project it to the visible viewport in terminal rows (wrapped width aware)
 * 3) diff/repaint only visible rows (or repaint visible rows when forced)
 * 4) clear stale rows below the new viewport when visible height shrinks
 * 5) restore cursor to prompt input column
 */
export function render(state: RenderState, options: RenderOptions = {}): void {
	const lines = computeLines(state)
	const out: string[] = []
	const screenRows = process.stdout.rows ?? Number.POSITIVE_INFINITY
	const cols = process.stdout.columns ?? Number.POSITIVE_INFINITY
	const prevVisible = getVisibleLines(prevLines, screenRows, cols)
	const nextVisible = getVisibleLines(lines, screenRows, cols)
	const prevRowStarts = getRowStarts(prevVisible, cols)
	const nextRowStarts = getRowStarts(nextVisible, cols)
	const prevVisibleRows = countRows(prevVisible, cols)
	const nextVisibleRows = countRows(nextVisible, cols)

	out.push(SYNC_START)
	out.push(HIDE_CURSOR)

	// Cursor row in viewport coordinates (0 = top row of viewport content).
	// We end every render on the prompt row, so on entry this starts at the
	// previous prompt row.
	let cursorRow = prevVisible.length > 0 ? prevRowStarts[prevVisible.length - 1]! : 0
	let didRender = false

	if (prevLines.length === 0 || options.force) {
		if (prevLines.length > 0 && prevVisibleRows > 0) {
			// On a forced redraw we are currently on the old prompt row. Move to the
			// top of the old visible area before repainting the new visible viewport.
			out.push(`\r${moveUp(cursorRow)}`)
			cursorRow = 0
		}
		writeLineRange(out, nextVisible, 0, nextVisible.length - 1)
		cursorRow = Math.max(0, nextVisibleRows - 1)
		didRender = nextVisible.length > 0
	} else {
		const changed = findChangedRange(prevVisible, nextVisible)
		if (changed) {
			const targetRow =
				changed.start < prevRowStarts.length
					? prevRowStarts[changed.start]!
					: prevVisibleRows

			// Carriage return first so clear+rewrite always starts at column 0.
			out.push(`\r${moveBetweenRows(cursorRow, targetRow)}`)
			cursorRow = targetRow

			const renderEnd = Math.min(changed.end, nextVisible.length - 1)
			if (renderEnd >= changed.start) {
				writeLineRange(out, nextVisible, changed.start, renderEnd)
				cursorRow =
					nextRowStarts[renderEnd]! +
					countLineRows(nextVisible[renderEnd]!, cols) -
					1
				didRender = true
			}
		}
	}

	if (nextVisibleRows < prevVisibleRows) {
		// The old frame had more visible rows than the new frame. Clear once from
		// the new last row to terminal end, so stale lines disappear.
		const newLastRow = Math.max(0, nextVisibleRows - 1)
		out.push(`\r${moveBetweenRows(cursorRow, newLastRow)}${ESC}[J`)
		cursorRow = newLastRow
		didRender = true
	}

	if (didRender) {
		const promptRow = nextVisible.length > 0 ? nextRowStarts[nextVisible.length - 1]! : 0
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
	const rows = process.stdout.rows ?? Number.POSITIVE_INFINITY
	const cols = process.stdout.columns ?? Number.POSITIVE_INFINITY
	const visibleLines = getVisibleLines(prevLines, rows, cols)
	const visibleRows = countRows(visibleLines, cols)
	if (visibleRows > 0) {
		process.stdout.write(`\r${moveUp(visibleRows - 1)}${ESC}[J`)
	}
	prevLines = []
}
