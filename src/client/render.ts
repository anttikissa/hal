// Terminal renderer — full repaint of our frame only.
// See docs/terminal.md for rules. Keep that file in sync with this one.
//
// After each render, the cursor sits on the last line (prompt).
// Next render: move up to the top of the frame, repaint downward.
// If the frame grows, extra \r\n at the bottom will scroll the terminal.
// We track how far we moved up so we always return to the right place.

const ESC = "\x1b"
const SYNC_START = `${ESC}[?2026h`
const SYNC_END = `${ESC}[?2026l`
const CLEAR_LINE = `${ESC}[2K`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
function moveUp(n: number): string {
	return n > 0 ? `${ESC}[${n}A` : ""
}

let prevLineCount = 0
let maxContentHeight = 0

export interface RenderMetrics {
	contentLines: number
	padding: number
	totalLines: number
	maxContentHeight: number
}

export let debugRender: RenderMetrics = {
	contentLines: 0,
	padding: 0,
	totalLines: 0,
	maxContentHeight: 0,
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

function getActualContentLines(blocks: string[]): string[] {
	const lines: string[] = []
	for (const block of blocks) {
		for (const line of block.split("\n")) {
			lines.push(line)
		}
	}
	return lines
}

export function getRenderMetrics(
	state: Pick<RenderState, 'blocks' | 'allTabBlockCounts' | 'tabs' | 'prompt'>,
	separatorLineCount: number,
): RenderMetrics {
	maxContentHeight = 0
	for (const count of state.allTabBlockCounts) {
		if (count > maxContentHeight) maxContentHeight = count
	}

	const contentLines = getActualContentLines(state.blocks).length
	const padding = Math.max(0, maxContentHeight - contentLines)
	return {
		contentLines,
		padding,
		totalLines:
			contentLines +
			padding +
			countLines(state.tabs) +
			separatorLineCount +
			countLines(state.prompt),
		maxContentHeight,
	}
}

function computeLines(state: RenderState): string[] {
	const actualContentLines = getActualContentLines(state.blocks)
	const metrics = getRenderMetrics(state, countLines(state.separator))
	const contentLines = [
		...Array.from({ length: metrics.padding }, () => ''),
		...actualContentLines,
	]

	debugRender = metrics

	// Keep blank space above short tabs so the visible lines stay near the prompt
	// when another tab has made the shared frame taller than this terminal.
	contentLines.push(...state.tabs.split('\n'))
	contentLines.push(...state.separator.split('\n'))
	contentLines.push(...state.prompt.split('\n'))
	return contentLines
}

export function render(state: RenderState): void {
	const lines = computeLines(state)
	const out: string[] = []

	out.push(SYNC_START)
	out.push(HIDE_CURSOR)

	if (prevLineCount === 0) {
		// First render: we're at the cursor's current position.
		// Just write lines. The \r\n will scroll the terminal as needed.
		for (let i = 0; i < lines.length; i++) {
			out.push(CLEAR_LINE + lines[i]!)
			if (i < lines.length - 1) out.push("\r\n")
		}
	} else {
		// Move up to top of previous frame
		out.push("\r" + moveUp(prevLineCount - 1))

		// Write all lines — if more than before, terminal scrolls naturally
		for (let i = 0; i < lines.length; i++) {
			out.push(CLEAR_LINE + lines[i]!)
			if (i < lines.length - 1) out.push("\r\n")
		}

		// Clear leftover lines if frame shrank
		if (prevLineCount > lines.length) {
			for (let i = lines.length; i < prevLineCount; i++) {
				out.push("\r\n" + CLEAR_LINE)
			}
			out.push(moveUp(prevLineCount - lines.length))
		}
	}

	prevLineCount = lines.length

	// Cursor on prompt line at the right column
	out.push(`\r${ESC}[${state.cursorCol}C`)
	out.push(SHOW_CURSOR)
	out.push(SYNC_END)

	process.stdout.write(out.join(""))
}

export function clearFrame(): void {
	if (prevLineCount === 0) return
	// Move from the prompt line back to the frame top, then clear to the screen end.
	// This matches the old restart behavior: the next process redraws into a clean area.
	process.stdout.write(`\r${moveUp(prevLineCount - 1)}${ESC}[J`)
	prevLineCount = 0
	maxContentHeight = 0
	debugRender = {
		contentLines: 0,
		padding: 0,
		totalLines: 0,
		maxContentHeight: 0,
	}
}
