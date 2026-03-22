// Terminal renderer for one logical "app frame" (content + chrome + prompt).
// See docs/terminal.md for the behavior contract.
//
// This module includes a small diff engine:
// - keep previous logical frame (`prevLines`)
// - compare current frame to previous frame
// - repaint only changed rows that are visible right now
//
// Why: repainting rows that are already in scrollback creates duplicated history.
// After each render we leave the cursor on the prompt row, ready for typing.
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
 * 1) build logical frame lines for current state
 * 2) diff against previous frame
 * 3) repaint only changed visible rows (or clear+redraw in unsafe shrink cases)
 * 4) restore cursor to prompt input column
 */
export function render(state: RenderState): void {
	const lines = computeLines(state)
	const out: string[] = []
	const screenRows = process.stdout.rows ?? Number.POSITIVE_INFINITY

	out.push(SYNC_START)
	out.push(HIDE_CURSOR)

	let cursorRow = prevLines.length - 1
	let didRender = false

	if (prevLines.length === 0) {
		writeLineRange(out, lines, 0, lines.length - 1)
		cursorRow = lines.length - 1
		didRender = true
	} else {
		// Diff engine: find first/last changed logical rows in the whole frame.
		// Indexes are in frame coordinates, not terminal row coordinates.
		let firstChanged = -1
		let lastChanged = -1
		const maxLen = Math.max(prevLines.length, lines.length)
		for (let i = 0; i < maxLen; i++) {
			if ((prevLines[i] ?? '') !== (lines[i] ?? '')) {
				if (firstChanged === -1) firstChanged = i
				lastChanged = i
			}
		}

		if (firstChanged !== -1) {
			const frameShrunk = prevLines.length > lines.length
			const prevViewportTop = Math.max(0, prevLines.length - screenRows)
			const nextViewportTop = Math.max(0, lines.length - screenRows)
			let start = firstChanged

			// Rows above prevViewportTop are already in scrollback and cannot be
			// safely rewritten. If a shrink crosses this boundary, do a visible clear
			// and redraw from the new viewport top.
			if (start < prevViewportTop) {
				if (lastChanged < prevViewportTop) {
					start = -1
				} else if (frameShrunk) {
					out.push(`${ESC}[2J${ESC}[H`)
					writeLineRange(out, lines, nextViewportTop, lines.length - 1)
					cursorRow = lines.length - 1
					didRender = true
					start = -1
				} else {
					start = prevViewportTop
				}
			}

			if (start >= 0) {
				start = Math.max(start, nextViewportTop)
			}

			if (start >= 0) {
				out.push(`\r${moveUp(cursorRow - start)}`)
				cursorRow = start
				const renderEnd = Math.min(lastChanged, lines.length - 1)
				if (renderEnd >= start) {
					writeLineRange(out, lines, start, renderEnd)
					cursorRow = renderEnd
					didRender = true
				}

				// If the frame shrank and is fully visible, clear stale rows under the
				// new last line. Move to exactly newLast before clearing to avoid adding
				// blank lines to scrollback when switching tabs.
				if (frameShrunk && lines.length < screenRows && didRender) {
					const newLast = lines.length - 1
					out.push(moveBetweenRows(cursorRow, newLast))
					cursorRow = newLast
					out.push(`\r${ESC}[J`)
				}
			}
		}
	}

	if (didRender) out.push(moveBetweenRows(cursorRow, lines.length - 1))
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
