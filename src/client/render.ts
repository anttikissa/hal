// Terminal renderer — full repaint of our frame only.
// See docs/terminal.md for rules. Keep that file in sync with this one.

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
let maxContentHeight = 0 // tallest tab's content (blocks only, not chrome)

export interface RenderState {
	blocks: string[]
	allTabBlockCounts: number[] // block line counts for every tab
	tabs: string
	separator: string
	prompt: string
	cursorCol: number
}

function computeLines(state: RenderState): string[] {
	const contentLines: string[] = []
	for (const block of state.blocks) {
		for (const line of block.split("\n")) {
			contentLines.push(line)
		}
	}

	// Track tallest tab so prompt stays stable across tab switches
	for (const count of state.allTabBlockCounts) {
		if (count > maxContentHeight) maxContentHeight = count
	}

	// Pad shorter tabs to match tallest
	while (contentLines.length < maxContentHeight) {
		contentLines.push("")
	}

	contentLines.push(state.tabs)
	contentLines.push(state.separator)
	contentLines.push(state.prompt)
	return contentLines
}

export function render(state: RenderState): void {
	const lines = computeLines(state)
	const out: string[] = []

	out.push(SYNC_START)
	out.push(HIDE_CURSOR)

	// Move up to the top of our previous frame
	if (prevLineCount > 0) {
		out.push("\r")
		out.push(moveUp(prevLineCount - 1))
	}

	// Paint new lines
	for (let i = 0; i < lines.length; i++) {
		out.push(CLEAR_LINE + lines[i]!)
		if (i < lines.length - 1) out.push("\r\n")
	}

	// Clear leftover lines from previous frame
	if (prevLineCount > lines.length) {
		for (let i = lines.length; i < prevLineCount; i++) {
			out.push("\r\n" + CLEAR_LINE)
		}
		// Move back up to the last line of the new frame
		out.push(moveUp(prevLineCount - lines.length))
	}

	prevLineCount = lines.length

	// Position cursor on prompt line
	out.push(`\r${ESC}[${state.cursorCol}C`)
	out.push(SHOW_CURSOR)
	out.push(SYNC_END)

	process.stdout.write(out.join(""))
}
