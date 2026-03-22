// Terminal renderer for one logical "app frame" (content + chrome + prompt).
// See docs/terminal.md for the behavior contract.
//
// Policy:
// - First paint is REPL-like: draw at current cursor without clearing.
// - Subsequent paints clear only the previous frame region (from previous frame
//   top to screen end), then repaint the full frame.
//
// This keeps shell output above `./run` intact while the app is shorter than
// the viewport. Once the frame reaches viewport height, redraw still works:
// move-up clamps at row 1 and we repaint the visible area from there.
const ESC = "\x1b"
const RESET = `${ESC}[0m`
const SYNC_START = `${ESC}[?2026h`
const SYNC_END = `${ESC}[?2026l`
const CLEAR_LINE = `${ESC}[2K`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
const ANSI_CSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

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

function moveUp(n: number): string {
	return n > 0 ? `${ESC}[${n}A` : ''
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_CSI_PATTERN, '')
}

function visibleWidth(text: string): number {
	return [...stripAnsi(text)].length
}

function countLineRows(line: string, cols: number): number {
	if (!Number.isFinite(cols) || cols <= 0) return 1
	return Math.max(1, Math.ceil(visibleWidth(line) / cols))
}

function countRenderedRows(lines: string[], cols: number): number {
	let rows = 0
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!
		const width = visibleWidth(line)
		rows += countLineRows(line, cols)
		if (i < lines.length - 1 && Number.isFinite(cols) && cols > 0 && width > 0 && width % cols === 0) {
			rows += 1
		}
	}
	return rows
}

export function countTextRows(
	text: string,
	cols = process.stdout.columns ?? Number.POSITIVE_INFINITY,
): number {
	return countRenderedRows(text.split('\n'), cols)
}

function countRows(lines: string[], cols: number): number {
	return countRenderedRows(lines, cols)
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

function writeLineRange(out: string[], lines: string[], start: number, end: number): void {
	if (end < start) return
	for (let i = start; i <= end; i++) {
		out.push(CLEAR_LINE + RESET + lines[i]!)
		if (i < end) out.push('\r\n')
	}
}

function clearPreviousFrame(out: string[]): void {
	if (prevLines.length === 0) return
	const cols = process.stdout.columns ?? Number.POSITIVE_INFINITY
	const rows = process.stdout.rows ?? Number.POSITIVE_INFINITY
	const prevRows = countRows(prevLines, cols)
	const visibleRows = Number.isFinite(rows)
		? Math.min(prevRows, Math.max(0, rows))
		: prevRows
	if (visibleRows <= 0) return
	out.push(`\r${moveUp(visibleRows - 1)}${ESC}[J`)
}

export function render(state: RenderState, options: RenderOptions = {}): void {
	const lines = computeLines(state)
	const out: string[] = []

	out.push(SYNC_START)
	out.push(HIDE_CURSOR)

	// First draw is append-only. Later draws repaint the frame region in place.
	if (prevLines.length > 0 || options.force) clearPreviousFrame(out)
	writeLineRange(out, lines, 0, lines.length - 1)

	prevLines = lines
	out.push(`\r${ESC}[${state.cursorCol}C`)
	out.push(SHOW_CURSOR)
	out.push(SYNC_END)
	process.stdout.write(out.join(''))
}

export function clearFrame(): void {
	if (prevLines.length === 0) return
	const cols = process.stdout.columns ?? Number.POSITIVE_INFINITY
	const rows = process.stdout.rows ?? Number.POSITIVE_INFINITY
	const prevRows = countRows(prevLines, cols)
	const visibleRows = Number.isFinite(rows)
		? Math.min(prevRows, Math.max(0, rows))
		: prevRows
	if (visibleRows > 0) {
		process.stdout.write(`\r${moveUp(visibleRows - 1)}${ESC}[J`)
	}
	prevLines = []
}
