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

export interface RenderState {
	blocks: string[]
	tabs: string
	separator: string
	prompt: string
	cursorCol: number
}

function computeLines(state: RenderState): string[] {
	const lines: string[] = []
	for (const block of state.blocks) {
		for (const line of block.split("\n")) {
			lines.push(line)
		}
	}
	lines.push(state.tabs)
	lines.push(state.separator)
	lines.push(state.prompt)
	return lines
}

export function render(state: RenderState): void {
	const lines = computeLines(state)
	const totalLines = Math.max(lines.length, prevLineCount)
	const out: string[] = []

	out.push(SYNC_START)
	out.push(HIDE_CURSOR)

	// Move up to the top of our previous frame
	if (prevLineCount > 0) {
		out.push("\r")
		out.push(moveUp(prevLineCount - 1))
	}

	// Paint all lines
	for (let i = 0; i < totalLines; i++) {
		out.push(CLEAR_LINE)
		if (i < lines.length) {
			out.push(lines[i]!)
		}
		if (i < totalLines - 1) {
			out.push("\r\n")
		}
	}

	prevLineCount = lines.length

	// Position cursor on prompt line, at the right column
	out.push(`\r${ESC}[${state.cursorCol}C`)
	out.push(SHOW_CURSOR)
	out.push(SYNC_END)

	process.stdout.write(out.join(""))
}
