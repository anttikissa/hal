// Terminal client — reference implementation.

import { render, emptyState, type RenderState, type CursorPos } from './cli-render.ts'
import { getWrappedInputLayout, cursorToWrappedRowCol, verticalMove, wordBoundaryLeft, wordBoundaryRight } from './cli-input.ts'

// ── State ──

interface Tab {
	id: number
	lines: string[]
}

let tabs: Tab[] = [{ id: 1, lines: [''] }]
let activeIdx = 0
let tabCounter = 1
let inputBuf = ''
let inputCursor = 0
let inputGoalCol: number | null = null
let halCursorVisible = true

function active(): Tab { return tabs[activeIdx] }

/** Append text to a tab's content, like a terminal receiving characters. */
function appendText(tab: Tab, text: string): void {
	for (const ch of text) {
		if (ch === '\n') {
			tab.lines.push('')
		} else {
			tab.lines[tab.lines.length - 1] += ch
		}
	}
}

// ── Terminal setup ──

const { stdin, stdout } = process
if (!stdin.isTTY) { console.error('Need a TTY'); process.exit(1) }
stdin.setRawMode(true)
stdin.setEncoding('utf8')
stdin.resume()

function cols(): number { return stdout.columns || 80 }
function contentWidth(): number { return cols() - 2 }

// ── Input helpers ──

function clampCursor(pos: number): number { return Math.max(0, Math.min(pos, inputBuf.length)) }

function insertAtCursor(text: string): void {
	inputBuf = inputBuf.slice(0, inputCursor) + text + inputBuf.slice(inputCursor)
	inputCursor += text.length
	inputGoalCol = null
}

function deleteRange(start: number, end: number): void {
	inputBuf = inputBuf.slice(0, start) + inputBuf.slice(end)
	inputCursor = start
	inputGoalCol = null
}

function moveCursor(pos: number): void {
	inputCursor = clampCursor(pos)
	inputGoalCol = null
}

function resetInput(): void {
	inputBuf = ''
	inputCursor = 0
	inputGoalCol = null
}

// ── Renderer ──

const DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m'
const MAX_PROMPT_LINES = 12

let renderState: RenderState = emptyState

function buildLines(): { lines: string[]; cursor: CursorPos } {
	const tab = active()
	const maxContentLines = Math.max(...tabs.map(t => t.lines.length))
	const lines: string[] = [...tab.lines]
	lines[lines.length - 1] += halCursorVisible ? '█' : ' '
	// Pad to match tallest tab, capped at screen height minus chrome
	const w = cols()
	const cw = contentWidth()
	const wrappedInput = getWrappedInputLayout(inputBuf, cw)
	const promptLines = Math.min(wrappedInput.lines.length, MAX_PROMPT_LINES)
	const chromeLines = 3 + promptLines // tab bar + separator + prompt lines + help bar
	const maxPad = Math.min(maxContentLines, Math.max(0, (stdout.rows || 24) - chromeLines))
	while (lines.length < maxPad) lines.push('')

	// Tab bar
	const parts = tabs.map((t, i) => {
		const label = ` ${t.id} `
		return i === activeIdx ? `${BOLD}[${label}]${RESET}` : `${DIM} ${label} ${RESET}`
	})
	lines.push(`tabs: ${parts.join('')}`)

	// Separator
	lines.push(`${DIM}${'─'.repeat(w)}${RESET}`)

	// Prompt lines with 1-char padding, scrolled to follow cursor
	const { row: curRow, col: curCol } = cursorToWrappedRowCol(inputBuf, inputCursor, cw)
	const totalWrapped = wrappedInput.lines.length
	let scrollTop = 0
	if (totalWrapped > promptLines) {
		// Keep cursor visible within the window
		scrollTop = Math.min(curRow, totalWrapped - promptLines)
		scrollTop = Math.max(scrollTop, curRow - promptLines + 1)
	}
	for (let i = scrollTop; i < scrollTop + promptLines; i++) {
		lines.push(` ${wrappedInput.lines[i] ?? ''}`)
	}
	const cursorPos: CursorPos = {
		row: lines.length - promptLines + (curRow - scrollTop),
		col: curCol + 2, // 1 padding + 1-based terminal column
	}

	// Help bar
	const help = ' ctrl-t new │ ctrl-n/p switch │ alt-enter newline │ ctrl-c quit '
	const pad = w - help.length
	const left = Math.max(0, Math.floor(pad / 2))
	const right = Math.max(0, pad - left)
	lines.push(`${DIM}${'─'.repeat(left)}${help}${'─'.repeat(right)}${RESET}`)

	return { lines, cursor: cursorPos }
}

function doRender(): void {
	const { lines, cursor: cursorPos } = buildLines()
	const { buf, state } = render(lines, renderState, cursorPos, stdout.rows || 24)
	renderState = state
	if (buf) stdout.write(buf)
}

// ── Streaming simulator ──

function simulateResponse(tab: Tab, text: string): void {
	let i = 0
	const tick = setInterval(() => {
		if (i >= text.length) { clearInterval(tick); return }
		appendText(tab, text[i])
		i++
		doRender()
	}, 30)
}

// ── Input handling ──

stdin.on('data', (data: string) => {
	// Ctrl-C: quit
	if (data === '\x03') {
		const delta = renderState.lines.length - 1 - renderState.cursorRow
		if (delta > 0) stdout.write(`\x1b[${delta}B`)
		stdout.write('\r\n\x1b[?25h')
		process.exit(0)
	}

	// Ctrl-T: new tab
	if (data === '\x14') {
		tabCounter++
		tabs.push({ id: tabCounter, lines: [''] })
		activeIdx = tabs.length - 1
		resetInput()
		doRender()
		return
	}

	// Ctrl-N / Ctrl-P: switch tabs
	if (data === '\x0e') { activeIdx = (activeIdx + 1) % tabs.length; doRender(); return }
	if (data === '\x10') { activeIdx = (activeIdx - 1 + tabs.length) % tabs.length; doRender(); return }

	// Enter: submit
	if (data === '\r' || data === '\n') {
		const text = inputBuf.trim()
		resetInput()
		if (text) {
			const tab = active()
			const spamMatch = text.match(/^spa(m+)$/)
			if (spamMatch) {
				const count = spamMatch[1].length * 30
				for (let i = 0; i < count; i++)
					tab.lines.push(`[tab ${tab.id}] line ${tab.lines.length}: LOTS OF TEXT BLAH BLAH`)
			} else {
				appendText(tab, `> ${text}\n`)
				const words = text.split(' ').length
				const response = `Message: "${text}"\n${text.length} chars, ${words} word${words === 1 ? '' : 's'}\n`
				simulateResponse(tab, response)
			}
		}
		doRender()
		return
	}

	// Alt-Enter: insert newline
	if (data === '\x1b\r' || data === '\x1b\n') {
		insertAtCursor('\n')
		doRender()
		return
	}

	// Backspace
	if (data === '\x7f' || data === '\x08') {
		if (inputCursor > 0) deleteRange(inputCursor - 1, inputCursor)
		doRender()
		return
	}

	// Ctrl-D: delete forward (or no-op if empty)
	if (data === '\x04') {
		if (inputCursor < inputBuf.length) deleteRange(inputCursor, inputCursor + 1)
		doRender()
		return
	}

	// Ctrl-A: start of line, Ctrl-E: end of line
	if (data === '\x01') { moveCursor(0); doRender(); return }
	if (data === '\x05') { moveCursor(inputBuf.length); doRender(); return }

	// Ctrl-K: kill to end
	if (data === '\x0b') {
		inputBuf = inputBuf.slice(0, inputCursor)
		inputGoalCol = null
		doRender()
		return
	}

	// Ctrl-W: delete word back
	if (data === '\x17') {
		if (inputCursor > 0) deleteRange(wordBoundaryLeft(inputBuf, inputCursor), inputCursor)
		doRender()
		return
	}

	// Arrow keys
	if (data === '\x1b[D') { moveCursor(inputCursor - 1); doRender(); return } // left
	if (data === '\x1b[C') { moveCursor(inputCursor + 1); doRender(); return } // right

	// Alt-Left / Alt-Right: word boundaries
	if (data === '\x1b[1;3D' || data === '\x1bb') { moveCursor(wordBoundaryLeft(inputBuf, inputCursor)); doRender(); return }
	if (data === '\x1b[1;3C' || data === '\x1bf') { moveCursor(wordBoundaryRight(inputBuf, inputCursor)); doRender(); return }

	// Up / Down: vertical movement in wrapped input
	if (data === '\x1b[A' || data === '\x1b[B') {
		const dir = data === '\x1b[A' ? -1 : 1
		const r = verticalMove(inputBuf, contentWidth(), inputCursor, inputGoalCol, dir)
		if (!r.atBoundary) {
			inputCursor = r.cursor
			inputGoalCol = r.goalCol
		}
		doRender()
		return
	}

	// Printable characters
	if (data >= ' ' && !data.startsWith('\x1b')) {
		insertAtCursor(data)
		doRender()
		return
	}
})

stdout.on('resize', () => {
	renderState = emptyState
	doRender()
})

setInterval(() => { halCursorVisible = !halCursorVisible; doRender() }, 530)
doRender()