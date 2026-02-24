/**
 * State-driven terminal UI with alternate screen buffer.
 *
 * Layout:
 *   Row  1                        = title bar (dim)
 *   Rows 2..(rows - footerH)     = output viewport (word-wrapped, scrollable)
 *   Row  (rows - footerH + 1)    = activity line (dim)
 *   Row  (rows - footerH + 2)    = status line (─[tabs]── context ─)
 *   Row  (rows - footerH + 3)    = empty dark-grey pad
 *   Rows ...                      = prompt text lines (dark-grey bg)
 *   Row  rows                     = empty dark-grey pad
 *
 * Single render() redraws every row from state on each change.
 */

import { stringify } from '../utils/ason.ts'
import { pasteFromClipboard, saveMultilinePaste } from './clipboard.ts'
import { logKeypress } from '../debug-log.ts'
import {
	parseKeys,
	readEscapeSequence,
	truncateAnsi,
	wrapAnsi,
	wordBoundaryLeft,
	wordBoundaryRight,
	wordWrapLines,
} from './tui-text.ts'
export { stripAnsi } from './format/index.ts'
import { stripAnsi } from './format/index.ts'

// ── Constants ──

export const CTRL_C = '\x03'

const CTRL_D = '\x04'
const CTRL_K = '\x0b'
const CTRL_U = '\x15'
const CTRL_V = '\x16'
const CTRL_Z = '\x1a'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

const MAX_OUTPUT_LINES = 10_000

const BG_DARK = '\x1b[48;5;236m'
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const STATUS_DIM = '\x1b[38;5;242m'
const TITLE_DIM = '\x1b[38;5;245m'

// ── Types ──

type TabCompleter = (prefix: string) => string[]
type InputKeyHandler = (key: string) => boolean | void
type InputEchoFilter = (value: string) => boolean
type SelectionPoint = { row: number; col: number }
type SelectionMode = 'char' | 'word' | 'line'

// ── Callbacks ──

let tabCompleter: TabCompleter | null = null
let inputKeyHandler: InputKeyHandler | null = null
let inputEchoFilter: InputEchoFilter | null = null
let escHandler: (() => void) | null = null
let doubleEnterHandler: (() => void) | null = null

export function setTabCompleter(fn: TabCompleter): void {
	tabCompleter = fn
}
export function setInputKeyHandler(handler: InputKeyHandler | null): void {
	inputKeyHandler = handler
}
export function setInputEchoFilter(handler: InputEchoFilter | null): void {
	inputEchoFilter = handler
}
export function setEscHandler(handler: (() => void) | null): void {
	escHandler = handler
}
export function setDoubleEnterHandler(handler: (() => void) | null): void {
	doubleEnterHandler = handler
}

// ── Input history ──

let inputHistory: string[] = []
let historyIndex = -1
let historyDraft = ''

export function getInputHistory(): string[] {
	return inputHistory
}
export function setInputHistory(history: string[]): void {
	inputHistory = history
	historyIndex = -1
	historyDraft = ''
}
export function getInputDraft(): { text: string; cursor: number } {
	return { text: inputBuf, cursor: inputCursor }
}
export function setInputDraft(text: string, cursor?: number): void {
	inputBuf = text
	inputCursor = cursor ?? text.length
	historyIndex = -1
	historyDraft = ''
}

// ── Prompt config ──

let maxPromptLines = 15

export function setMaxPromptLines(n: number): void {
	maxPromptLines = Math.max(1, Math.min(n, 50))
}

// ── Core state ──

let initialized = false
let ended = false
let suspended = false

// Output: array of logical lines (unwrapped, with ANSI)
let outputLines: string[] = ['']
let scrollOffset = 0
let wrappedLineCount = 1
let lastWrapCols = 0

// Title, activity, status
let titleBarStr = ''
let activityStr = ''
let statusTabsStr = ''
let statusRightStr = ''
let headerFlash = ''
let headerFlashTimer: ReturnType<typeof setTimeout> | null = null

// Input
let inputBuf = ''
let inputCursor = 0
let inputPromptStr = '> '
let waitingResolve: ((value: string | null) => void) | null = null
let lastSubmitTime = 0

// Mouse selection
let selAnchor: SelectionPoint | null = null
let selCurrent: SelectionPoint | null = null
let selMode: SelectionMode = 'char'
let selActive = false
let lastClickTime = 0
let lastClickPos: SelectionPoint | null = null
let clickCount = 0
let lastVisibleOutput: string[] = []
let lastOutputHeight = 0

// Bracketed paste
let bracketedPasteBuffer: string | null = null

// Stdin coalescing
let stdinBuffer = ''
let stdinTimer: ReturnType<typeof setTimeout> | null = null
const STDIN_COALESCE_MS = 50

// ── Geometry helpers ──

function cols(): number {
	return process.stdout.columns || 80
}
function rows(): number {
	return process.stdout.rows || 24
}

function promptLineCount(): number {
	const c = cols()
	if (c <= 0) return 1
	const contentWidth = c - 1 - inputPromptStr.length
	const lines = wordWrapLines(inputBuf, contentWidth)
	return Math.max(1, Math.min(lines.length, maxPromptLines))
}

/** Footer: activity(1) + status(1) + padTop(1) + promptLines + padBottom(1) */
function footerHeight(): number {
	return 4 + promptLineCount()
}

function outputBottom(): number {
	return Math.max(1, rows() - footerHeight())
}

function activityRow(): number {
	return rows() - footerHeight() + 1
}

function statusRow(): number {
	return activityRow() + 1
}

function promptTopPadRow(): number {
	return statusRow() + 1
}

function promptFirstRow(): number {
	return promptTopPadRow() + 1
}

// ── Low-level terminal writes ──

function directWrite(text: string): void {
	process.stdout.write(text)
}

function showCursor(): void {
	directWrite(`\x1b[?25h`)
}

// ── Output storage ──

function appendOutput(text: string): void {
	if (!text) return
	let i = 0
	while (i < text.length) {
		const ch = text[i]
		if (ch === '\n') {
			outputLines.push('')
			i++
			continue
		}
		if (ch === '\r') {
			outputLines[outputLines.length - 1] = ''
			i++
			continue
		}
		let end = i
		while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++
		outputLines[outputLines.length - 1] += text.slice(i, end)
		i = end
	}
	if (outputLines.length > MAX_OUTPUT_LINES) {
		outputLines = outputLines.slice(-MAX_OUTPUT_LINES)
	}
	// Invalidate wrapped line cache
	lastWrapCols = 0
}

// ── Viewport ──

function getTotalVisualLines(): number {
	const c = cols()
	if (lastWrapCols === c) return wrappedLineCount
	let total = 0
	for (const line of outputLines) {
		total += wrapAnsi(line, c).length
	}
	wrappedLineCount = total
	lastWrapCols = c
	return total
}

function getVisibleWrapped(outputHeight: number): string[] {
	const c = cols()
	const need = outputHeight + scrollOffset
	const allWrapped: string[] = []

	for (let li = outputLines.length - 1; li >= 0; li--) {
		const wrapped = wrapAnsi(outputLines[li], c)
		for (let wi = wrapped.length - 1; wi >= 0; wi--) {
			allWrapped.push(wrapped[wi])
		}
		if (allWrapped.length >= need) break
	}

	allWrapped.reverse()
	const totalCollected = allWrapped.length
	const end = totalCollected - Math.min(scrollOffset, totalCollected)
	const start = Math.max(0, end - outputHeight)
	return allWrapped.slice(start, end)
}

// ── Scroll ──

function scroll(lines: number): void {
	if (!initialized || suspended) return
	const oh = Math.max(0, outputBottom() - 1)
	const totalVisual = getTotalVisualLines()
	const maxScroll = Math.max(0, totalVisual - oh)
	scrollOffset = Math.max(0, Math.min(maxScroll, scrollOffset + lines))
	render()
}

// ── Status line builder ──

function buildStatusLine(): string {
	const c = cols()
	const left = statusTabsStr
	const right = headerFlash || statusRightStr
	const rightPart = right ? ` ${right} ─` : ' ─'
	const leftPart = left ? `─${left}─` : '─'

	// Scroll indicator
	let scrollPart = ''
	if (scrollOffset > 0) {
		scrollPart = ` ↑${scrollOffset} `
	}

	const fixedLen = leftPart.length + scrollPart.length + rightPart.length
	const dashCount = Math.max(0, c - fixedLen)
	const line = leftPart + '─'.repeat(dashCount) + scrollPart + rightPart
	return `${STATUS_DIM}${line.slice(0, c)}${RESET}`
}

// ── Input cursor mapping ──

function cursorToRowCol(absPos: number, width: number): { row: number; col: number } {
	const wrapped = wordWrapLines(inputBuf, width)
	let charsSoFar = 0
	for (let i = 0; i < wrapped.length; i++) {
		const lineLen = wrapped[i].length
		const breakChar =
			i < wrapped.length - 1 && charsSoFar + lineLen < inputBuf.length
				? inputBuf[charsSoFar + lineLen]
				: ''
		const consumed = lineLen + (breakChar === ' ' || breakChar === '\n' ? 1 : 0)
		if (absPos <= charsSoFar + lineLen) {
			return { row: i, col: absPos - charsSoFar }
		}
		charsSoFar += consumed
	}
	const lastLine = wrapped.length - 1
	return { row: lastLine, col: wrapped[lastLine]?.length ?? 0 }
}

// ── Mouse selection ──

function getSelectionRange(): {
	startRow: number
	startCol: number
	endRow: number
	endCol: number
} | null {
	if (!selAnchor || !selCurrent) return null
	let a = selAnchor
	let b = selCurrent

	if (selMode === 'word') {
		a = expandToWordBoundary(a, 'start')
		b = expandToWordBoundary(b, 'end')
	} else if (selMode === 'line') {
		a = { row: a.row, col: 0 }
		b = { row: b.row, col: cols() }
	}

	if (a.row > b.row || (a.row === b.row && a.col > b.col)) {
		if (selMode === 'word') {
			const aSwap = expandToWordBoundary(selCurrent, 'start')
			const bSwap = expandToWordBoundary(selAnchor, 'end')
			return {
				startRow: aSwap.row,
				startCol: aSwap.col,
				endRow: bSwap.row,
				endCol: bSwap.col,
			}
		}
		return { startRow: b.row, startCol: b.col, endRow: a.row, endCol: a.col }
	}
	return { startRow: a.row, startCol: a.col, endRow: b.row, endCol: b.col }
}

function expandToWordBoundary(pt: SelectionPoint, side: 'start' | 'end'): SelectionPoint {
	const line = lastVisibleOutput[pt.row] ?? ''
	const plain = stripAnsi(line)
	const col = Math.min(pt.col, plain.length)

	if (side === 'start') {
		let i = Math.min(col, plain.length - 1)
		if (i < 0) return { row: pt.row, col: 0 }
		while (i > 0 && /\s/.test(plain[i])) i--
		while (i > 0 && !/\s/.test(plain[i - 1])) i--
		return { row: pt.row, col: i }
	} else {
		let i = col
		while (i < plain.length && /\s/.test(plain[i])) i++
		while (i < plain.length && !/\s/.test(plain[i])) i++
		return { row: pt.row, col: i }
	}
}

function renderLineWithSelection(
	line: string,
	row: number,
	sel: { startRow: number; startCol: number; endRow: number; endCol: number },
): string {
	const plain = stripAnsi(line)
	const truncated = plain.slice(0, cols())

	let selStart = 0
	let selEnd = truncated.length
	if (row === sel.startRow) selStart = Math.max(0, sel.startCol)
	if (row === sel.endRow) selEnd = Math.min(truncated.length, sel.endCol)

	if (selStart >= selEnd) {
		return truncateAnsi(line, cols())
	}

	const result: string[] = []
	let visCol = 0
	let inSel = false
	let i = 0
	const c = cols()

	while (i < line.length && visCol < c) {
		if (line[i] === '\x1b') {
			const seqLen = readEscapeSequence(line, i)
			result.push(line.slice(i, i + seqLen))
			i += seqLen
			continue
		}

		if (visCol === selStart && !inSel) {
			result.push('\x1b[7m')
			inSel = true
		}
		if (visCol === selEnd && inSel) {
			result.push('\x1b[27m')
			inSel = false
		}

		result.push(line[i])
		visCol++
		i++
	}

	if (inSel) result.push('\x1b[27m')
	result.push(RESET)
	return result.join('')
}

function handleMouseEvent(x: number, y: number, kind: 'press' | 'move' | 'release'): void {
	// Only handle clicks in the output area (rows 2..outputBottom, 0-indexed: 1..outputBottom-1)
	const oh = Math.max(0, outputBottom() - 1)
	// y is 0-based row on screen, output starts at row index 1 (row 2 on screen)
	const outputRow = y - 1 // convert to 0-based index into visible output
	if (outputRow < 0 || outputRow >= oh) {
		if (kind === 'press') clearSelection()
		return
	}

	const pt: SelectionPoint = { row: outputRow, col: x }

	if (kind === 'press') {
		const now = Date.now()
		const samePos =
			lastClickPos && lastClickPos.row === outputRow && Math.abs(lastClickPos.col - x) <= 1

		if (samePos && now - lastClickTime < 400) {
			clickCount = Math.min(clickCount + 1, 3)
		} else {
			clickCount = 1
		}
		lastClickTime = now
		lastClickPos = pt

		if (clickCount === 1) selMode = 'char'
		else if (clickCount === 2) selMode = 'word'
		else selMode = 'line'

		selAnchor = pt
		selCurrent = pt
		selActive = true
		render()
	} else if (kind === 'move' && selActive) {
		selCurrent = pt
		render()
	} else if (kind === 'release' && selActive) {
		selCurrent = pt
		selActive = false
		copySelectionToClipboard()
		render()
	}
}

function copySelectionToClipboard(): void {
	const sel = getSelectionRange()
	if (!sel) return

	const lines: string[] = []
	for (let row = sel.startRow; row <= sel.endRow; row++) {
		const plain = stripAnsi(lastVisibleOutput[row] ?? '')
		const start = row === sel.startRow ? sel.startCol : 0
		const end = row === sel.endRow ? sel.endCol : plain.length
		lines.push(plain.slice(start, end))
	}

	const text = lines.join('\n')
	if (!text) return

	try {
		const proc = Bun.spawn(['pbcopy'], { stdin: 'pipe' })
		proc.stdin.write(text)
		proc.stdin.end()
	} catch {
		// Ignore clipboard failures
	}
}

function clearSelection(): void {
	if (!selAnchor) return
	selAnchor = null
	selCurrent = null
	selActive = false
	render()
}

// ── Mouse/paste terminal modes ──

function enableMouse(): void {
	directWrite('\x1b[?1000h\x1b[?1002h\x1b[?1006h')
	directWrite('\x1b[?2004h')
}

function disableMouse(): void {
	directWrite('\x1b[?1006l\x1b[?1002l\x1b[?1000l')
	directWrite('\x1b[?2004l')
}

// ── Render ──

let renderScheduled = false
// Cached from last render for resize scroll preservation
let lastRenderedOutputHeight = 0
let lastRenderedTotalVisual = 0

function scheduleRender(): void {
	if (renderScheduled) return
	renderScheduled = true
	queueMicrotask(render)
}

function render(): void {
	renderScheduled = false
	if (!initialized || ended || suspended) return

	const r = rows()
	const c = cols()
	const fh = footerHeight()
	const ob = Math.max(1, r - fh) // last row of output viewport
	const outputHeight = Math.max(0, ob - 1) // rows 2..ob

	// Clamp scroll offset
	if (scrollOffset > 0) {
		const totalVisual = getTotalVisualLines()
		const maxScroll = Math.max(0, totalVisual - outputHeight)
		if (scrollOffset > maxScroll) scrollOffset = maxScroll
	}

	const visibleOutput = getVisibleWrapped(outputHeight)
	lastVisibleOutput = visibleOutput
	lastOutputHeight = outputHeight
	lastRenderedOutputHeight = outputHeight
	lastRenderedTotalVisual = getTotalVisualLines()

	const selRange = getSelectionRange()

	const chunks: string[] = []
	chunks.push('\x1b[?25l') // hide cursor

	// Row 1: title bar
	chunks.push(`\x1b[1;1H\x1b[2K`)
	const titleText = titleBarStr || 'New conversation'
	chunks.push(truncateAnsi(`${TITLE_DIM}  ${titleText}`, c))

	// Rows 2..ob: output viewport
	for (let row = 2; row <= ob; row++) {
		chunks.push(`\x1b[${row};1H\x1b[2K`)
		const idx = row - 2
		const lineText = visibleOutput[idx] ?? ''
		if (selRange && idx >= selRange.startRow && idx <= selRange.endRow) {
			chunks.push(renderLineWithSelection(lineText, idx, selRange))
		} else {
			chunks.push(truncateAnsi(lineText, c))
		}
	}

	// Activity line
	const aRow = activityRow()
	chunks.push(`\x1b[${aRow};1H\x1b[2K`)
	const actText = activityStr ? `  Model: ${activityStr}` : '  Model: Idle'
	chunks.push(truncateAnsi(`${DIM}${actText}`, c))

	// Status line
	const sRow = statusRow()
	chunks.push(`\x1b[${sRow};1H\x1b[2K`)
	chunks.push(buildStatusLine())

	// Prompt top pad
	const ptRow = promptTopPadRow()
	chunks.push(`\x1b[${ptRow};1H\x1b[2K`)
	chunks.push(`${BG_DARK}${' '.repeat(c)}${RESET}`)

	// Prompt lines
	const contentWidth = c - 1 - inputPromptStr.length
	const wrapped = wordWrapLines(inputBuf, contentWidth)
	const pLines = Math.min(wrapped.length, maxPromptLines)
	const firstRow = promptFirstRow()
	for (let i = 0; i < pLines; i++) {
		const chunk = inputPromptStr + wrapped[i]
		const padded = chunk + ' '.repeat(Math.max(0, c - chunk.length))
		chunks.push(`\x1b[${firstRow + i};1H\x1b[2K`)
		chunks.push(`${BG_DARK}${padded}${RESET}`)
	}

	// Prompt bottom pad
	chunks.push(`\x1b[${r};1H\x1b[2K`)
	chunks.push(`${BG_DARK}${' '.repeat(c)}${RESET}`)

	// Position cursor at input
	const { row: curRow, col: curCol } = cursorToRowCol(inputCursor, contentWidth)
	const cursorScreenRow = firstRow + curRow
	const cursorScreenCol = curCol + 1 + inputPromptStr.length
	chunks.push(`\x1b[${cursorScreenRow};${cursorScreenCol}H`)
	chunks.push('\x1b[?25h') // show cursor

	directWrite(chunks.join(''))
}

// ── Suspend/resume ──

function suspendForegroundJob(): void {
	suspended = true

	// Dump visible output before leaving alt screen so it's readable while suspended
	const c = cols()
	const oh = Math.max(0, outputBottom() - 1)
	const visible = getVisibleWrapped(oh)

	disableMouse()
	showCursor()
	directWrite('\x1b[?1049l') // leave alt screen
	if (process.stdin.isTTY) process.stdin.setRawMode(false)

	directWrite(`\x1b[${rows()};1H\r\n`)
	for (const line of visible) {
		directWrite(truncateAnsi(line, c) + '\r\n')
	}

	try {
		process.kill(0, 'SIGSTOP')
	} catch {
		process.kill(process.pid, 'SIGSTOP')
	}
}

// ── Bracketed paste handler ──

function handleBracketedPaste(text: string): void {
	if (!waitingResolve) return
	const clean = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
	if (!clean) return
	const isMultiline = clean.includes('\n')
	const insert = isMultiline ? saveMultilinePaste(clean) : clean
	inputBuf = inputBuf.slice(0, inputCursor) + insert + inputBuf.slice(inputCursor)
	inputCursor += insert.length
	render()
}

// ── Key handler ──

function handleKey(key: string): void {
	if (inputKeyHandler && inputKeyHandler(key)) return

	if (key === CTRL_C) {
		if (waitingResolve) {
			const r = waitingResolve
			waitingResolve = null
			r(CTRL_C)
		} else {
			cleanup()
			process.exit(100)
		}
		return
	}
	if (key === CTRL_D) {
		if (inputBuf.length === 0 && waitingResolve) {
			const r = waitingResolve
			waitingResolve = null
			r(null)
		}
		return
	}
	if (key === CTRL_Z) {
		suspendForegroundJob()
		return
	}

	if (key === CTRL_V) {
		pasteFromClipboard().then((content) => {
			if (!content) return
			const clean = content
				.replace(/\r\n/g, '\n')
				.replace(/\r/g, '\n')
				.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '')
			if (!clean) return
			const isMultiline = clean.includes('\n')
			const insert = isMultiline ? saveMultilinePaste(clean) : clean
			inputBuf = inputBuf.slice(0, inputCursor) + insert + inputBuf.slice(inputCursor)
			inputCursor += insert.length
			render()
		})
		return
	}

	// Shift+Enter / Option+Enter: insert newline
	if (key === '\x1b\r' || key === '\x1b\n' || key === '\x1b[13;2u' || key === '\x1b[27;2;13~') {
		inputBuf = inputBuf.slice(0, inputCursor) + '\n' + inputBuf.slice(inputCursor)
		inputCursor++
		render()
		return
	}

	if (key === '\r' || key === '\n') {
		const value = inputBuf
		const now = Date.now()

		if (!value.trim() && lastSubmitTime > 0 && now - lastSubmitTime < 500) {
			lastSubmitTime = 0
			if (doubleEnterHandler) doubleEnterHandler()
			return
		}

		if (value.trim()) {
			inputHistory.push(value)
			lastSubmitTime = now
		}
		historyIndex = -1
		historyDraft = ''
		inputBuf = ''
		inputCursor = 0
		render()
		if (waitingResolve) {
			const r = waitingResolve
			waitingResolve = null
			r(value)
		}
		return
	}

	// Option+Backspace: delete word left
	if (key === '\x1b\x7f') {
		if (inputCursor > 0) {
			const b = wordBoundaryLeft(inputBuf, inputCursor)
			inputBuf = inputBuf.slice(0, b) + inputBuf.slice(inputCursor)
			inputCursor = b
			render()
		}
		return
	}

	// Backspace
	if (key === '\x7f' || key === '\b') {
		if (inputCursor > 0) {
			inputBuf = inputBuf.slice(0, inputCursor - 1) + inputBuf.slice(inputCursor)
			inputCursor--
			render()
		}
		return
	}

	// Delete
	if (key === '\x1b[3~') {
		if (inputCursor < inputBuf.length) {
			inputBuf = inputBuf.slice(0, inputCursor) + inputBuf.slice(inputCursor + 1)
			render()
		}
		return
	}

	// Arrow left / right
	if (key === '\x1b[D' || key === '\x1bOD') {
		if (inputCursor > 0) {
			inputCursor--
			render()
		}
		return
	}
	if (key === '\x1b[C' || key === '\x1bOC') {
		if (inputCursor < inputBuf.length) {
			inputCursor++
			render()
		}
		return
	}

	// Opt-left / Opt-right (word jump)
	if (key === '\x1b[1;3D' || key === '\x1bb') {
		inputCursor = wordBoundaryLeft(inputBuf, inputCursor)
		render()
		return
	}
	if (key === '\x1b[1;3C' || key === '\x1bf') {
		inputCursor = wordBoundaryRight(inputBuf, inputCursor)
		render()
		return
	}

	// Home / Ctrl-A
	if (
		key === '\x1b[H' ||
		key === '\x1bOH' ||
		key === '\x01' ||
		key === '\x1b[1;9D' ||
		key === '\x1b[1;2D'
	) {
		inputCursor = 0
		render()
		return
	}
	// End / Ctrl-E
	if (
		key === '\x1b[F' ||
		key === '\x1bOF' ||
		key === '\x05' ||
		key === '\x1b[1;9C' ||
		key === '\x1b[1;2C'
	) {
		inputCursor = inputBuf.length
		render()
		return
	}

	// Ctrl-U / Ctrl-K
	if (key === CTRL_U) {
		inputBuf = inputBuf.slice(inputCursor)
		inputCursor = 0
		render()
		return
	}
	if (key === CTRL_K) {
		inputBuf = inputBuf.slice(0, inputCursor)
		render()
		return
	}

	// Arrow up
	if (key === '\x1b[A' || key === '\x1bOA') {
		if (inputBuf.includes('\n')) {
			const pos = inputCursor
			const lineStart = inputBuf.lastIndexOf('\n', pos - 1)
			if (lineStart >= 0) {
				const colInLine = pos - lineStart - 1
				const prevLineStart = inputBuf.lastIndexOf('\n', lineStart - 1) + 1
				const prevLineLen = lineStart - prevLineStart
				inputCursor = prevLineStart + Math.min(colInLine, prevLineLen)
				render()
				return
			}
		}
		if (inputHistory.length === 0) return
		if (historyIndex < 0) {
			historyDraft = inputBuf
			historyIndex = inputHistory.length - 1
		} else if (historyIndex > 0) historyIndex--
		else return
		inputBuf = inputHistory[historyIndex]
		inputCursor = inputBuf.length
		render()
		return
	}

	// Arrow down
	if (key === '\x1b[B' || key === '\x1bOB') {
		if (inputBuf.includes('\n')) {
			const pos = inputCursor
			const nextNewline = inputBuf.indexOf('\n', pos)
			if (nextNewline >= 0) {
				const lineStart = inputBuf.lastIndexOf('\n', pos - 1) + 1
				const colInLine = pos - lineStart
				const nextLineStart = nextNewline + 1
				const nextNextNewline = inputBuf.indexOf('\n', nextLineStart)
				const nextLineLen =
					(nextNextNewline >= 0 ? nextNextNewline : inputBuf.length) - nextLineStart
				inputCursor = nextLineStart + Math.min(colInLine, nextLineLen)
				render()
				return
			}
		}
		if (historyIndex < 0) return
		if (historyIndex < inputHistory.length - 1) {
			historyIndex++
			inputBuf = inputHistory[historyIndex]
		} else {
			historyIndex = -1
			inputBuf = historyDraft
			historyDraft = ''
		}
		inputCursor = inputBuf.length
		render()
		return
	}

	// PageUp / PageDown / Shift+Up / Shift+Down: scroll output
	if (key === '\x1b[5~') {
		scroll(Math.max(1, rows() - 3))
		return
	}
	if (key === '\x1b[6~') {
		scroll(-Math.max(1, rows() - 3))
		return
	}
	if (key === '\x1b[1;2A') {
		scroll(3)
		return
	}
	if (key === '\x1b[1;2B') {
		scroll(-3)
		return
	}

	// Tab completion
	if (key === '\t') {
		if (tabCompleter) {
			const matches = tabCompleter(inputBuf)
			if (matches.length === 1) {
				inputBuf = matches[0]
				inputCursor = inputBuf.length
				render()
			} else if (matches.length > 1) {
				let common = matches[0]
				for (let i = 1; i < matches.length; i++) {
					while (common.length > 0 && !matches[i].startsWith(common)) {
						common = common.slice(0, -1)
					}
				}
				if (common.length > inputBuf.length) {
					inputBuf = common
					inputCursor = inputBuf.length
				}
				writeToOutput(`\x1b[2m${matches.join('  ')}\x1b[0m\n`)
				render()
			}
		}
		return
	}

	// Esc
	if (key === '\x1b') {
		if (escHandler) escHandler()
		return
	}

	// Ignore other control characters
	if (key.length === 1 && key.charCodeAt(0) < 0x20) return

	// xterm modifyOtherKeys
	const modifyOtherKeys = key.match(/^\x1b\[27;\d+;(\d+)~$/)
	if (modifyOtherKeys) {
		const ch = String.fromCharCode(Number(modifyOtherKeys[1]))
		if (ch) {
			inputBuf = inputBuf.slice(0, inputCursor) + ch + inputBuf.slice(inputCursor)
			inputCursor += ch.length
			render()
		}
		return
	}

	// Skip unknown escape sequences
	if (key.startsWith('\x1b')) return

	// Multi-character paste (outside bracketed paste)
	const isMultiline = key.length > 1 && key.includes('\n')
	if (isMultiline) {
		const ref = saveMultilinePaste(key)
		inputBuf = inputBuf.slice(0, inputCursor) + ref + inputBuf.slice(inputCursor)
		inputCursor += ref.length
	} else {
		const clean = key.replace(/[\x00-\x1f]/g, '')
		if (!clean) return
		inputBuf = inputBuf.slice(0, inputCursor) + clean + inputBuf.slice(inputCursor)
		inputCursor += clean.length
	}
	render()
}

// ── Stdin processing ──

function flushStdinBuffer(): void {
	const data = stdinBuffer
	stdinBuffer = ''
	stdinTimer = null
	logKeypress(data)

	// Any non-mouse keypress clears selection
	if (selAnchor && !data.includes('\x1b[<')) {
		clearSelection()
	}

	for (const key of parseKeys(data, PASTE_START, PASTE_END)) handleKey(key)
}

const onStdinData = (chunk: Buffer | string) => {
	const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
	if (!text) return

	// Bracketed paste: accumulate between start/end markers
	if (bracketedPasteBuffer !== null) {
		const endIdx = text.indexOf(PASTE_END)
		if (endIdx >= 0) {
			bracketedPasteBuffer += text.slice(0, endIdx)
			handleBracketedPaste(bracketedPasteBuffer)
			bracketedPasteBuffer = null
			// Process any remaining data after the paste end
			const rest = text.slice(endIdx + PASTE_END.length)
			if (rest) onStdinData(rest)
		} else {
			bracketedPasteBuffer += text
		}
		return
	}
	if (text.includes(PASTE_START)) {
		const startIdx = text.indexOf(PASTE_START) + PASTE_START.length
		const endIdx = text.indexOf(PASTE_END, startIdx)
		if (endIdx >= 0) {
			handleBracketedPaste(text.slice(startIdx, endIdx))
			const rest = text.slice(endIdx + PASTE_END.length)
			if (rest) onStdinData(rest)
		} else {
			bracketedPasteBuffer = text.slice(startIdx)
		}
		return
	}

	// Mouse events: process immediately without coalescing
	const mouseRe = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
	let mouseMatch = mouseRe.exec(text)
	if (mouseMatch) {
		let scrollDelta = 0
		do {
			const button = parseInt(mouseMatch[1], 10)
			const x = parseInt(mouseMatch[2], 10) // 1-based
			const y = parseInt(mouseMatch[3], 10) // 1-based
			const isRelease = mouseMatch[4] === 'm'
			const isMove = (button & 32) !== 0
			const baseButton = button & ~32

			if (baseButton === 64) scrollDelta += 3
			else if (baseButton === 65) scrollDelta -= 3
			else if (baseButton === 0) {
				handleMouseEvent(x - 1, y - 1, isRelease ? 'release' : isMove ? 'move' : 'press')
			}
			mouseMatch = mouseRe.exec(text)
		} while (mouseMatch)
		if (scrollDelta !== 0) scroll(scrollDelta)
		return
	}

	stdinBuffer += text
	if (stdinTimer) clearTimeout(stdinTimer)
	if (stdinBuffer.includes(PASTE_START) && !stdinBuffer.includes(PASTE_END)) {
		stdinTimer = setTimeout(flushStdinBuffer, STDIN_COALESCE_MS)
	} else {
		flushStdinBuffer()
	}
}

const onStdinEnd = () => {
	if (suspended) return
	ended = true
	if (waitingResolve) {
		const r = waitingResolve
		waitingResolve = null
		r(null)
	}
}

// ── Output write ──

function writeToOutput(text: string): void {
	if (!text) return
	// Clear selection on new output (positions become stale)
	if (selAnchor) {
		selAnchor = null
		selCurrent = null
		selActive = false
	}
	const wasAtBottom = scrollOffset === 0
	appendOutput(text)
	if (wasAtBottom) scrollOffset = 0 // stay at bottom
	render()
}

// ── Resize ──

function onResize(): void {
	if (!initialized || suspended) return

	if (scrollOffset > 0 && lastRenderedTotalVisual > 0) {
		// Preserve viewport center position across re-wrap
		const centerFromBottom = scrollOffset + lastRenderedOutputHeight / 2
		const fraction = centerFromBottom / lastRenderedTotalVisual

		lastWrapCols = 0 // invalidate before recomputing
		const newTotal = getTotalVisualLines()
		const newOutputHeight = Math.max(0, Math.max(1, rows() - footerHeight()) - 1)
		scrollOffset = Math.max(0, Math.round(fraction * newTotal - newOutputHeight / 2))
	} else {
		lastWrapCols = 0
	}

	render()
}

// ── SIGCONT ──

function onSigCont(): void {
	if (!initialized) return
	suspended = false
	ended = false
	try {
		enterRawMode()
	} catch {
		// Terminal gone (e.g. kill %), just exit
		initialized = false
		process.exit(0)
	}
	directWrite('\x1b[?1049h') // re-enter alt screen
	enableMouse()
	render()
}

function enterRawMode(): void {
	process.stdin.setEncoding('utf8')
	if (process.stdin.isTTY) process.stdin.setRawMode(true)
	process.stdin.resume()
}

// ── Flash header ──

export function flashHeader(text: string, durationMs = 1500): void {
	if (headerFlashTimer) clearTimeout(headerFlashTimer)
	headerFlash = text
	if (initialized) scheduleRender()
	headerFlashTimer = setTimeout(() => {
		headerFlash = ''
		headerFlashTimer = null
		if (initialized) scheduleRender()
	}, durationMs)
}

// ── Serialization helpers ──

function safeStringify(value: unknown): string {
	if (typeof value === 'string') return value
	try {
		return stringify(value)
	} catch {
		return String(value)
	}
}

// ── Public API ──

export function init(): void {
	if (initialized) return
	initialized = true
	ended = false
	suspended = false
	inputBuf = ''
	inputCursor = 0
	outputLines = ['']
	scrollOffset = 0
	lastWrapCols = 0
	wrappedLineCount = 1

	enterRawMode()
	directWrite('\x1b[?1049h') // enter alt screen
	enableMouse()
	process.stdin.on('data', onStdinData)
	process.stdin.on('end', onStdinEnd)
	process.on('SIGCONT', onSigCont)
	process.stdout.on('resize', onResize)

	render()
}

export function write(text: string): void {
	writeToOutput(text)
}

export function log(...args: any[]): void {
	write(args.map((a) => safeStringify(a)).join(' ') + '\n')
}

export function setActivityLine(text: string): void {
	if (activityStr === text) return
	activityStr = text
	if (initialized) scheduleRender()
}

export function setTitleBar(text: string): void {
	if (titleBarStr === text) return
	titleBarStr = text
	if (initialized) scheduleRender()
}

export function setStatusLine(tabsStr: string, rightStr: string): void {
	statusTabsStr = tabsStr
	statusRightStr = rightStr
	if (initialized) scheduleRender()
}

export function getOutputSnapshot(): string {
	return outputLines.join('\n')
}

export function setOutputSnapshot(snapshot: string): void {
	outputLines = ['']
	lastWrapCols = 0
	appendOutput(snapshot)
}

export function clearOutput(): void {
	outputLines = ['']
	scrollOffset = 0
	lastWrapCols = 0
	wrappedLineCount = 1
	if (initialized) render()
}

export function replaceOutput(snapshot: string): void {
	outputLines = ['']
	scrollOffset = 0
	lastWrapCols = 0
	wrappedLineCount = 1
	if (snapshot) appendOutput(snapshot)
	if (initialized) render()
}

export function input(promptStr: string): Promise<string | null> {
	if (!initialized) init()
	if (waitingResolve) {
		const r = waitingResolve
		waitingResolve = null
		r(null)
	}
	inputPromptStr = promptStr
	inputBuf = ''
	inputCursor = 0
	render()
	if (ended) return Promise.resolve(null)
	return new Promise((resolve) => {
		waitingResolve = resolve
	})
}

export function cancelInput(): void {
	if (waitingResolve) {
		const r = waitingResolve
		waitingResolve = null
		r(null)
	}
}

export function prompt(message: string, promptStr: string): Promise<string | null> {
	write(`${message}\n`)
	return input(promptStr)
}

export function cleanup(): void {
	if (!initialized) return
	initialized = false
	suspended = false
	if (headerFlashTimer) {
		clearTimeout(headerFlashTimer)
		headerFlashTimer = null
	}
	headerFlash = ''

	// Capture visible output before leaving alt screen
	const c = cols()
	const oh = Math.max(0, outputBottom() - 1)
	const visible = getVisibleWrapped(oh)
	const dumpLines = visible.map((line) => truncateAnsi(line, c))

	showCursor()
	disableMouse()
	directWrite('\x1b[?1049l') // leave alt screen — restores pre-TUI screen + cursor
	if (process.stdin.isTTY) process.stdin.setRawMode(false)
	process.stdin.off('data', onStdinData)
	process.stdin.off('end', onStdinEnd)
	process.off('SIGCONT', onSigCont)
	process.stdout.off('resize', onResize)

	// Dump output to main screen so it persists in scrollback.
	// Move to bottom row first so the dump scrolls naturally below existing content.
	directWrite(`\x1b[${rows()};1H\r\n`)
	for (const line of dumpLines) {
		directWrite(line + '\r\n')
	}
	// Push shell prompt to bottom — match the footer height we had
	const padding = footerHeight() - 1 // -1 because shell itself occupies a line
	for (let i = 0; i < padding; i++) directWrite('\r\n')



	if (waitingResolve) {
		const r = waitingResolve
		waitingResolve = null
		r(null)
	}
}
