// Terminal renderer — full repaint on every frame.
// The terminal is just a canvas. We compute all lines, then paint them.

const ESC = "\x1b"
const SYNC_START = `${ESC}[?2026h`
const SYNC_END = `${ESC}[?2026l`
const CLEAR_LINE = `${ESC}[2K`
const MOVE_HOME = `${ESC}[H`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`

let prevLineCount = 0

export interface RenderState {
	blocks: string[] // rendered text blocks (each may be multiline)
	tabs: string // tab bar line
	separator: string // separator line
	prompt: string // prompt input line
	cursorCol: number // cursor column in prompt (0-based)
}

function computeLines(state: RenderState): string[] {
	const lines: string[] = []

	// Content blocks
	for (const block of state.blocks) {
		for (const line of block.split("\n")) {
			lines.push(line)
		}
	}

	// Tab bar
	lines.push(state.tabs)

	// Separator
	lines.push(state.separator)

	// Prompt
	lines.push(state.prompt)

	return lines
}

export function render(state: RenderState): void {
	const lines = computeLines(state)
	const out: string[] = []

	out.push(SYNC_START)
	out.push(HIDE_CURSOR)
	out.push(MOVE_HOME)

	for (const line of lines) {
		out.push(CLEAR_LINE + line + "\r\n")
	}

	// Clear leftover lines from previous frame
	for (let i = lines.length; i < prevLineCount; i++) {
		out.push(CLEAR_LINE + "\r\n")
	}

	prevLineCount = lines.length

	// Position cursor on prompt line
	const promptRow = lines.length
	out.push(`${ESC}[${promptRow};${state.cursorCol + 1}H`)
	out.push(SHOW_CURSOR)
	out.push(SYNC_END)

	process.stdout.write(out.join(""))
}
