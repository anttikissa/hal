/**
 * State-driven terminal UI with alternate screen buffer.
 *
 * Layout:
 *   Row  1                        = Title bar
 *   Rows 2..(rows - footerH)     = Output (word-wrapped, scrollable)
 *   Row  (rows - footerH + 1)    = Activity bar
 *   Row  (rows - footerH + 2)    = Tab bar / status bar
 *   Row  (rows - footerH + 3)    = Input top pad (dark-grey)
 *   Rows ...                      = Input (dark-grey background)
 *   Row  rows                     = Input bottom pad (dark-grey)
 *
 * Single render() redraws every row from state on each change.
 */

import { stringify } from '../utils/ason.ts'
import { pasteFromClipboard, saveMultilinePaste } from './clipboard.ts'
import { logKeypress } from '../debug-log.ts'
import { linkifyLine, normalizeDetectedUrl, underlineOsc8Link, urlAtCol } from './tui-links.ts'
import {
	parseKeys,
	readEscapeSequence,
	truncateAnsi,
	wrapAnsi,
	wordBoundaryLeft,
	wordBoundaryRight,
	wordWrapLines,
} from './tui-text.ts'
import {
	cursorToWrappedRowCol,
	getWrappedInputLayout,
	wrappedRowColToCursor,
} from './tui-input-layout.ts'
export { stripAnsi } from './format/index.ts'
import { stripAnsi } from './format/index.ts'
import { buildStatusBarLine } from './tui/format/status-bar.ts'

// ── Constants ──

export const CTRL_C = '\x03'

const CTRL_D = '\x04'
const CTRL_K = '\x0b'
const CTRL_U = '\x15'
const CTRL_V = '\x16'
const CTRL_X = '\x18'
const CTRL_Y = '\x19'
const CTRL_Z = '\x1a'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

const MAX_OUTPUT_LINES = 10_000

const BG_DARK = '\x1b[48;5;236m'
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const TITLE_DIM = '\x1b[38;5;245m'
const TITLE_BG = '\x1b[48;5;238m'
// Flags: 1=disambiguate, 2=report events, 8=report all (Super key), 16=report associated text
const KITTY_KEYBOARD_ENABLE = '\x1b[>27u'
const KITTY_KEYBOARD_DISABLE = '\x1b[<u'

// ── Types ──

type TabCompleter = (prefix: string) => string[]
type InputKeyHandler = (key: string) => boolean | void
type InputEchoFilter = (value: string) => boolean
type SelectionSurface = 'output' | 'activity' | 'status' | 'input'
type SelectionPoint = { surface: SelectionSurface; row: number; col: number }
type SelectionRange = {
	surface: SelectionSurface
	startRow: number
	startCol: number
	endRow: number
	endCol: number
}
type SelectionMode = 'char' | 'word' | 'line'
type InputUndoSnapshot = {
	text: string
	cursor: number
	selAnchor: number | null
	selFocus: number | null
}

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
	clearInputTextSelection()
	clearInputUndoHistory()
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
let inputSelAnchor: number | null = null
let inputSelFocus: number | null = null
let inputSelActive = false
let inputUndoStack: InputUndoSnapshot[] = []
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
let lastActivityLine = ''
let lastStatusLine = ''
// Link hover (Cmd+hover)
let hoverOutputRow = -1
let hoverUrl: string | null = null
let superHeld = false
let lastMouseX = -1
let lastMouseY = -1

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

function supportsKittyKeyboard(): boolean {
	const tp = process.env.TERM_PROGRAM
	return !!process.env.KITTY_PID || tp === 'kitty' || tp === 'ghostty' || process.env.TERM === 'xterm-kitty'
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
		const wrapped = wrapAnsi(linkifyLine(outputLines[li]), c)
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
	const prev = scrollOffset
	scrollOffset = Math.max(0, Math.min(maxScroll, scrollOffset + lines))
	const delta = scrollOffset - prev
	// Shift output selection so it tracks the same content
	if (delta !== 0 && selAnchor?.surface === 'output') {
		selAnchor = { ...selAnchor, row: selAnchor.row + delta }
		if (selCurrent) selCurrent = { ...selCurrent, row: selCurrent.row + delta }
	}
	hoverOutputRow = -1
	hoverUrl = null
	render()
}

// ── Status line builder ──

function buildStatusLine(): string {
	return buildStatusBarLine(cols(), statusTabsStr, headerFlash || statusRightStr, scrollOffset)
}

// ── Input selection/edit helpers ──

function clampInputPos(pos: number): number {
	return Math.max(0, Math.min(pos, inputBuf.length))
}

function getInputTextSelectionRange(): { start: number; end: number } | null {
	if (inputSelAnchor === null || inputSelFocus === null) return null
	const a = clampInputPos(inputSelAnchor)
	const b = clampInputPos(inputSelFocus)
	if (a === b) return null
	return a < b ? { start: a, end: b } : { start: b, end: a }
}

function clearInputUndoHistory(): void {
	inputUndoStack = []
}

function currentInputUndoSnapshot(): InputUndoSnapshot {
	return {
		text: inputBuf,
		cursor: inputCursor,
		selAnchor: inputSelAnchor,
		selFocus: inputSelFocus,
	}
}

function pushInputUndoSnapshot(): void {
	const prev = inputUndoStack[inputUndoStack.length - 1]
	if (
		prev &&
		prev.text === inputBuf &&
		prev.cursor === inputCursor &&
		prev.selAnchor === inputSelAnchor &&
		prev.selFocus === inputSelFocus
	) {
		return
	}
	inputUndoStack.push(currentInputUndoSnapshot())
	if (inputUndoStack.length > 200) inputUndoStack.splice(0, inputUndoStack.length - 200)
}

function restoreInputUndoSnapshot(snap: InputUndoSnapshot): void {
	inputBuf = snap.text
	inputCursor = clampInputPos(snap.cursor)
	inputSelAnchor = snap.selAnchor === null ? null : clampInputPos(snap.selAnchor)
	inputSelFocus = snap.selFocus === null ? null : clampInputPos(snap.selFocus)
	inputSelActive = false
}

function undoInputEdit(): boolean {
	const snap = inputUndoStack.pop()
	if (!snap) return false
	restoreInputUndoSnapshot(snap)
	return true
}

function clearInputTextSelection(): void {
	inputSelAnchor = null
	inputSelFocus = null
	inputSelActive = false
}

function setInputCursor(pos: number, extendSelection = false): void {
	const next = clampInputPos(pos)
	if (extendSelection) {
		if (inputSelAnchor === null) inputSelAnchor = inputCursor
		inputSelFocus = next
	} else {
		clearInputTextSelection()
	}
	inputCursor = next
}

function replaceInputRange(start: number, end: number, text: string): void {
	pushInputUndoSnapshot()
	const a = clampInputPos(start)
	const b = clampInputPos(end)
	const lo = Math.min(a, b)
	const hi = Math.max(a, b)
	inputBuf = inputBuf.slice(0, lo) + text + inputBuf.slice(hi)
	inputCursor = lo + text.length
	clearInputTextSelection()
}

function deleteInputTextSelection(): boolean {
	const sel = getInputTextSelectionRange()
	if (!sel) return false
	replaceInputRange(sel.start, sel.end, '')
	return true
}

function insertIntoInput(text: string): void {
	const sel = getInputTextSelectionRange()
	if (sel) {
		replaceInputRange(sel.start, sel.end, text)
		return
	}
	pushInputUndoSnapshot()
	inputBuf = inputBuf.slice(0, inputCursor) + text + inputBuf.slice(inputCursor)
	inputCursor += text.length
}

function collapseInputSelection(edge: 'start' | 'end'): boolean {
	const sel = getInputTextSelectionRange()
	if (!sel) return false
	inputCursor = edge === 'start' ? sel.start : sel.end
	clearInputTextSelection()
	return true
}

function lineBoundaryLeft(buf: string, cursor: number): number {
	return buf.lastIndexOf('\n', Math.max(0, cursor) - 1) + 1
}

function lineBoundaryRight(buf: string, cursor: number): number {
	const i = buf.indexOf('\n', Math.max(0, cursor))
	return i >= 0 ? i : buf.length
}

function inputWordRangeAt(pos: number): { start: number; end: number } {
	const clamped = clampInputPos(pos)
	if (inputBuf.length === 0) return { start: 0, end: 0 }
	let start = clamped
	let end = clamped
	if (clamped < inputBuf.length && /\s/.test(inputBuf[clamped])) {
		while (start > 0 && /\s/.test(inputBuf[start - 1])) start--
		while (end < inputBuf.length && /\s/.test(inputBuf[end])) end++
		return { start, end }
	}
	start = wordBoundaryLeft(inputBuf, clamped)
	end = wordBoundaryRight(inputBuf, clamped)
	return { start, end }
}

function inputLineRangeAt(pos: number): { start: number; end: number } {
	const clamped = clampInputPos(pos)
	return {
		start: lineBoundaryLeft(inputBuf, clamped),
		end: lineBoundaryRight(inputBuf, clamped),
	}
}

function writeClipboardText(text: string): void {
	if (!text) return
	try {
		const proc = Bun.spawn(['pbcopy'], { stdin: 'pipe' })
		proc.stdin.write(text)
		proc.stdin.end()
	} catch {
		// Ignore clipboard failures
	}
}

function copyInputTextSelectionToClipboard(): boolean {
	const sel = getInputTextSelectionRange()
	if (!sel) return false
	writeClipboardText(inputBuf.slice(sel.start, sel.end))
	return true
}

function copyCurrentSelectionToClipboard(): boolean {
	if (copyInputTextSelectionToClipboard()) return true
	const sel = getSelectionRange()
	if (!sel) return false
	const text = screenSelectionText(sel)
	if (!text) return false
	writeClipboardText(text)
	return true
}

function cutInputTextSelectionToClipboard(): boolean {
	const sel = getInputTextSelectionRange()
	if (!sel) return false
	writeClipboardText(inputBuf.slice(sel.start, sel.end))
	replaceInputRange(sel.start, sel.end, '')
	return true
}

function cutCurrentInputLineToClipboard(): boolean {
	const start = inputBuf.lastIndexOf('\n', Math.max(0, inputCursor - 1)) + 1
	const nextNewline = inputBuf.indexOf('\n', inputCursor)
	const end = nextNewline === -1 ? inputBuf.length : nextNewline + 1
	if (start >= end) return false
	writeClipboardText(inputBuf.slice(start, end))
	replaceInputRange(start, end, '')
	return true
}


function pasteClipboardIntoInput(): void {
	pasteFromClipboard().then((content) => {
		if (!content) return
		const clean = content
			.replace(/\r\n/g, '\n')
			.replace(/\r/g, '\n')
			.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '')
		if (!clean) return
		const insert = clean.includes('\n') ? saveMultilinePaste(clean) : clean
		insertIntoInput(insert)
		render()
	})
}

function setInputTextWithUndo(text: string, cursor = text.length): void {
	if (text === inputBuf && cursor === inputCursor) return
	pushInputUndoSnapshot()
	inputBuf = text
	inputCursor = clampInputPos(cursor)
	clearInputTextSelection()
}

function handleInputClipboardShortcutKey(key: string): boolean {
	const modOther = key.match(/^\x1b\[27;(\d+);(\d+)~$/)
	const csiU = parseKittyCsiUKey(key)
	if (csiU && csiU.eventType !== 1) return true
	const modifier = Number(modOther?.[1] ?? csiU?.rawModifier ?? NaN)
	const codepoint = Number(modOther?.[2] ?? csiU?.codepoint ?? NaN)
	if (!Number.isFinite(modifier) || !Number.isFinite(codepoint) || modifier < 9) return false
	const ch = String.fromCharCode(codepoint).toLowerCase()
	if (ch === 'c') {
		if (copyCurrentSelectionToClipboard()) render()
		return true
	}
	if (ch === 'x') {
		if (cutInputTextSelectionToClipboard() || cutCurrentInputLineToClipboard()) render()
		return true
	}
	if (ch === 'v') {
		pasteClipboardIntoInput()
		return true
	}
	if (ch === 'a') {
		inputSelAnchor = 0
		inputSelFocus = inputBuf.length
		inputCursor = inputBuf.length
		inputSelActive = false
		render()
		return true
	}
	if (ch === 'z') {
		if (undoInputEdit()) render()
		return true
	}
	return false
}

function inputPosFromWrappedPoint(row: number, col: number): number {
	const width = cols() - 1 - inputPromptStr.length
	return wrappedRowColToCursor(inputBuf, row, Math.max(0, col), width)
}

function inputWrappedPointFromScreen(x: number, y: number): { row: number; col: number } | null {
	const c = cols()
	const contentWidth = c - 1 - inputPromptStr.length
	const { lines } = getWrappedInputLayout(inputBuf, contentWidth)
	const pLines = Math.min(lines.length, maxPromptLines)
	const firstRow = promptFirstRow()
	const row = y - (firstRow - 1)
	if (row < 0 || row >= pLines) return null
	const col = Math.max(0, x - inputPromptStr.length)
	return { row, col }
}

function renderPromptLineWithInputSelection(
	lineText: string,
	lineStart: number,
	screenCols: number,
	inputSel: { start: number; end: number } | null,
): string {
	const baseLen = inputPromptStr.length + lineText.length
	const pad = ' '.repeat(Math.max(0, screenCols - baseLen))
	if (!inputSel) return `${BG_DARK}${inputPromptStr}${lineText}${pad}${RESET}`

	const selStart = Math.max(0, Math.min(lineText.length, inputSel.start - lineStart))
	const selEnd = Math.max(0, Math.min(lineText.length, inputSel.end - lineStart))
	if (selStart >= selEnd) return `${BG_DARK}${inputPromptStr}${lineText}${pad}${RESET}`

	const before = lineText.slice(0, selStart)
	const selected = lineText.slice(selStart, selEnd)
	const after = lineText.slice(selEnd)
	return `${BG_DARK}${inputPromptStr}${before}\x1b[7m${selected}\x1b[27m${after}${pad}${RESET}`
}

// ── Mouse selection ──

function screenSelectionLine(surface: SelectionSurface, row: number): string {
	if (surface === 'activity') return row === 0 ? lastActivityLine : ''
	if (surface === 'status') return row === 0 ? lastStatusLine : ''
	if (surface === 'output') return lastVisibleOutput[row] ?? ''
	return ''
}

function screenSelectionText(sel: SelectionRange): string {
	const lines: string[] = []
	for (let row = sel.startRow; row <= sel.endRow; row++) {
		const plain = stripAnsi(screenSelectionLine(sel.surface, row))
		const start = row === sel.startRow ? sel.startCol : 0
		const end = row === sel.endRow ? sel.endCol : plain.length
		lines.push(plain.slice(start, end))
	}
	return lines.join('\n')
}

function getSelectionRange(): {
	surface: SelectionSurface
	startRow: number
	startCol: number
	endRow: number
	endCol: number
} | null {
	if (!selAnchor || !selCurrent) return null
	if (selAnchor.surface !== selCurrent.surface) return null
	let a = selAnchor
	let b = selCurrent

	if (selMode === 'word') {
		a = expandToWordBoundary(a, 'start')
		b = expandToWordBoundary(b, 'end')
	} else if (selMode === 'line') {
		a = { ...a, col: 0 }
		b = { ...b, col: cols() }
	}

	if (a.row > b.row || (a.row === b.row && a.col > b.col)) {
		if (selMode === 'word') {
			const aSwap = expandToWordBoundary(selCurrent, 'start')
			const bSwap = expandToWordBoundary(selAnchor, 'end')
			return {
				surface: aSwap.surface,
				startRow: aSwap.row,
				startCol: aSwap.col,
				endRow: bSwap.row,
				endCol: bSwap.col,
			}
		}
		return {
			surface: b.surface,
			startRow: b.row,
			startCol: b.col,
			endRow: a.row,
			endCol: a.col,
		}
	}
	return {
		surface: a.surface,
		startRow: a.row,
		startCol: a.col,
		endRow: b.row,
		endCol: b.col,
	}
}

function selectionLine(pt: SelectionPoint): string {
	if (pt.surface === 'input') {
		const width = cols() - 1 - inputPromptStr.length
		return getWrappedInputLayout(inputBuf, width).lines[pt.row] ?? ''
	}
	return screenSelectionLine(pt.surface, pt.row)
}

function expandToWordBoundary(pt: SelectionPoint, side: 'start' | 'end'): SelectionPoint {
	const line = selectionLine(pt)
	const plain = stripAnsi(line)
	const col = Math.min(pt.col, plain.length)

	if (side === 'start') {
		let i = Math.min(col, plain.length - 1)
		if (i < 0) return { ...pt, col: 0 }
		while (i > 0 && /\s/.test(plain[i])) i--
		while (i > 0 && !/\s/.test(plain[i - 1])) i--
		return { ...pt, col: i }
	} else {
		let i = col
		while (i < plain.length && /\s/.test(plain[i])) i++
		while (i < plain.length && !/\s/.test(plain[i])) i++
		return { ...pt, col: i }
	}
}

function renderLineWithSelection(
	line: string,
	row: number,
	sel: SelectionRange,
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
			const seq = line.slice(i, i + seqLen)
			result.push(seq)
			// Embedded SGR (especially \x1b[0m) can cancel inverse-video mid-selection.
			// Re-apply selection highlight so dragging stays visually continuous.
			if (inSel && seq.startsWith('\x1b[') && seq.endsWith('m')) result.push('\x1b[7m')
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

function pointFromScreenCoords(x: number, y: number): SelectionPoint | null {
	const inputPt = inputWrappedPointFromScreen(x, y)
	if (inputPt) return { surface: 'input', row: inputPt.row, col: inputPt.col }

	// y is 0-based row on screen. Output starts at row 2 (index 1).
	const oh = Math.max(0, outputBottom() - 1)
	const outputRow = y - 1
	if (outputRow >= 0 && outputRow < oh) {
		return { surface: 'output', row: outputRow, col: x }
	}
	if (y === activityRow() - 1) {
		return { surface: 'activity', row: 0, col: x }
	}
	if (y === statusRow() - 1) {
		return { surface: 'status', row: 0, col: x }
	}
	return null
}

function updateHoverLink(): void {
	let newRow = -1
	let newUrl: string | null = null
	if (superHeld && lastMouseX >= 0) {
		const pt = pointFromScreenCoords(lastMouseX, lastMouseY)
		if (pt?.surface === 'output') {
			const line = lastVisibleOutput[pt.row] ?? ''
			newUrl = urlAtCol(line, pt.col)
			if (newUrl) newRow = pt.row
		}
	}
	if (newRow !== hoverOutputRow || newUrl !== hoverUrl) {
		hoverOutputRow = newRow
		hoverUrl = newUrl
		render()
	}
}


function handleMouseEvent(x: number, y: number, kind: 'press' | 'move' | 'release'): void {
	if (kind === 'press') {
		const pt = pointFromScreenCoords(x, y)
		if (!pt) {
			const hadInputSel = inputSelAnchor !== null || inputSelFocus !== null
			clearInputTextSelection()
			if (selAnchor) clearSelection()
			else if (hadInputSel) render()
			return
		}
		const now = Date.now()
		const samePos =
			lastClickPos &&
			lastClickPos.surface === pt.surface &&
			lastClickPos.row === pt.row &&
			Math.abs(lastClickPos.col - x) <= 1

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

		if (pt.surface === 'input') {
			if (selAnchor) clearSelection(false)
			const pos = inputPosFromWrappedPoint(pt.row, pt.col)
			if (clickCount === 2) {
				const range = inputWordRangeAt(pos)
				inputSelAnchor = range.start
				inputSelFocus = range.end
				inputCursor = range.end
			} else if (clickCount >= 3) {
				const range = inputLineRangeAt(pos)
				inputSelAnchor = range.start
				inputSelFocus = range.end
				inputCursor = range.end
			} else {
				inputSelAnchor = pos
				inputSelFocus = pos
				inputCursor = pos
			}
			inputSelActive = true
			render()
			return
		}

		clearInputTextSelection()

		selAnchor = pt
		selCurrent = pt
		selActive = true
		render()
		return
	}

	if (kind === 'move' && selActive) {
		const pt = pointFromScreenCoords(x, y)
		if (!pt || !selAnchor || pt.surface !== selAnchor.surface) return
		selCurrent = pt
		render()
		return
	}

	if (kind === 'move' && inputSelActive) {
		const pt = pointFromScreenCoords(x, y)
		if (!pt || pt.surface !== 'input') return
		const pos = inputPosFromWrappedPoint(pt.row, pt.col)
		if (selMode === 'word') {
			const range = inputWordRangeAt(pos)
			inputSelFocus = inputSelAnchor !== null && range.start < inputSelAnchor
				? range.start : range.end
		} else if (selMode === 'line') {
			const range = inputLineRangeAt(pos)
			inputSelFocus = inputSelAnchor !== null && range.start < inputSelAnchor
				? range.start : range.end
		} else {
			inputSelFocus = pos
		}
		inputCursor = inputSelFocus
		render()
		return
	}

	// Cmd+hover detection for link underline
	if (kind === 'move' && !selActive && !inputSelActive) {
		lastMouseX = x
		lastMouseY = y
		updateHoverLink()
		return
	}

	if (kind === 'release' && selActive) {
		const pt = pointFromScreenCoords(x, y)
		if (pt && selAnchor && pt.surface === selAnchor.surface) selCurrent = pt
		selActive = false
		// Single click (no drag) on output — check for URL
		if (
			clickCount === 1 &&
			pt &&
			selAnchor &&
			pt.surface === 'output' &&
			pt.row === selAnchor.row &&
			pt.col === selAnchor.col
		) {
			const line = lastVisibleOutput[pt.row] ?? ''
			const url = urlAtCol(line, pt.col)
			if (url) {
				selAnchor = null
				selCurrent = null
				render()
				const normalized = normalizeDetectedUrl(url)
				if (!normalized) {
					render()
					return
				}
				Bun.spawn(['open', normalized])
				return
			}
		}
		render()
		return
	}

	if (kind === 'release' && inputSelActive) {
		const pt = pointFromScreenCoords(x, y)
		if (pt && pt.surface === 'input') {
			const pos = inputPosFromWrappedPoint(pt.row, pt.col)
			if (selMode === 'word') {
				const range = inputWordRangeAt(pos)
				// Extend toward whichever side is farther from anchor
				inputSelFocus = inputSelAnchor !== null && range.start < inputSelAnchor
					? range.start : range.end
				inputCursor = inputSelFocus
			} else if (selMode === 'line') {
				const range = inputLineRangeAt(pos)
				inputSelFocus = inputSelAnchor !== null && range.start < inputSelAnchor
					? range.start : range.end
				inputCursor = inputSelFocus
			} else {
				inputSelFocus = pos
				inputCursor = pos
			}
		}
		inputSelActive = false
		render()
	}
}

function copySelectionToClipboard(): void {
	const sel = getSelectionRange()
	if (!sel) return
	const text = screenSelectionText(sel)
	if (!text) return

	writeClipboardText(text)
}

function clearSelection(renderNow = true): void {
	if (!selAnchor) return
	selAnchor = null
	selCurrent = null
	selActive = false
	if (renderNow) render()
}

// ── Mouse/paste terminal modes ──

function enableMouse(): void {
	if (supportsKittyKeyboard()) directWrite(KITTY_KEYBOARD_ENABLE)
	directWrite('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h')
	directWrite('\x1b[?2004h')
}

function disableMouse(): void {
	if (supportsKittyKeyboard()) directWrite(KITTY_KEYBOARD_DISABLE)
	directWrite('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l')
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
	lastRenderedOutputHeight = outputHeight
	lastRenderedTotalVisual = getTotalVisualLines()

	const selRange = getSelectionRange()

	const chunks: string[] = []
	chunks.push('\x1b[?25l') // hide cursor

	// Row 1: title bar
	chunks.push(`\x1b[1;1H\x1b[2K`)
	const titleText = titleBarStr || 'New conversation'
	const titleLine = `${TITLE_BG}${TITLE_DIM}  ${titleText}`
	chunks.push(truncateAnsi(titleLine, c) + RESET)

	// Rows 2..ob: output viewport
	for (let row = 2; row <= ob; row++) {
		chunks.push(`\x1b[${row};1H\x1b[2K`)
		const idx = row - 2
		let lineText = visibleOutput[idx] ?? ''
		if (hoverUrl && idx === hoverOutputRow) lineText = underlineOsc8Link(lineText, hoverUrl)
		if (selRange?.surface === 'output' && idx >= selRange.startRow && idx <= selRange.endRow) {
			chunks.push(renderLineWithSelection(lineText, idx, selRange))
		} else {
			chunks.push(truncateAnsi(lineText, c))
		}
	}

	// Activity line
	const aRow = activityRow()
	const activityLine = truncateAnsi(`${DIM}${activityStr ? `  Model: ${activityStr}` : '  Model: Idle'}`, c)
	lastActivityLine = activityLine
	chunks.push(`\x1b[${aRow};1H\x1b[2K`)
	if (selRange?.surface === 'activity') chunks.push(renderLineWithSelection(activityLine, 0, selRange))
	else chunks.push(activityLine)

	// Status line
	const sRow = statusRow()
	const statusLine = buildStatusLine()
	lastStatusLine = statusLine
	chunks.push(`\x1b[${sRow};1H\x1b[2K`)
	if (selRange?.surface === 'status') chunks.push(renderLineWithSelection(statusLine, 0, selRange))
	else chunks.push(statusLine)

	// Prompt top pad
	const ptRow = promptTopPadRow()
	chunks.push(`\x1b[${ptRow};1H\x1b[2K`)
	chunks.push(`${BG_DARK}${' '.repeat(c)}${RESET}`)

	// Prompt lines
	const contentWidth = c - 1 - inputPromptStr.length
	const wrappedInput = getWrappedInputLayout(inputBuf, contentWidth)
	const wrapped = wrappedInput.lines
	const inputSelRange = getInputTextSelectionRange()
	const pLines = Math.min(wrapped.length, maxPromptLines)
	const firstRow = promptFirstRow()
	for (let i = 0; i < pLines; i++) {
		chunks.push(`\x1b[${firstRow + i};1H\x1b[2K`)
		chunks.push(
			renderPromptLineWithInputSelection(wrapped[i], wrappedInput.starts[i] ?? 0, c, inputSelRange),
		)
	}

	// Prompt bottom pad
	chunks.push(`\x1b[${r};1H\x1b[2K`)
	chunks.push(`${BG_DARK}${' '.repeat(c)}${RESET}`)

	// Position cursor at input
	const { row: curRow, col: curCol } = cursorToWrappedRowCol(inputBuf, inputCursor, contentWidth)
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
	const clean = text
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '')
	if (!clean) return
	const isMultiline = clean.includes('\n')
	const insert = isMultiline ? saveMultilinePaste(clean) : clean
	insertIntoInput(insert)
	render()
}

const SUPER_L = 57444
const SUPER_R = 57450

type KittyCsiUKey = {
	codepoint: number
	rawModifier: number
	eventType: number
	text?: string // associated text from flag 16
}

function parseKittyCsiUKey(key: string): KittyCsiUKey | null {
	if (!key.startsWith('\x1b[') || !key.endsWith('u')) return null
	const body = key.slice(2, -1)
	const fields = body.split(';')
	if (fields.length < 1) return null
	const codepoint = Number((fields[0] || '').split(':', 1)[0])
	let rawModifier = 1
	let eventType = 1 // 1=press, 2=repeat, 3=release
	if (fields.length >= 2) {
		const [rawModifierStr, eventTypeStr] = (fields[1] ?? '').split(':', 2)
		if (rawModifierStr) rawModifier = Number(rawModifierStr)
		if (eventTypeStr) eventType = Number(eventTypeStr)
	}
	if (!Number.isFinite(codepoint) || !Number.isFinite(rawModifier) || !Number.isFinite(eventType))
		return null
	// Parse associated text (third field): colon-separated codepoints
	let text: string | undefined
	if (fields.length >= 3 && fields[2]) {
		const cps = fields[2].split(':').map(Number)
		if (cps.length > 0 && cps.every((n) => Number.isFinite(n) && n > 0)) {
			text = String.fromCodePoint(...cps)
		}
	}
	return { codepoint, rawModifier, eventType, text }
}

/** Strip Kitty event-type from functional key CSI sequences (arrows, home, end, F-keys, etc).
 *  E.g. \x1b[1;1:2A (repeat arrow-up) → \x1b[A, \x1b[1;3:2D (repeat opt-left) → \x1b[1;3D.
 *  Returns undefined if not a Kitty-enhanced sequence, null to suppress (release), or the
 *  normalized legacy sequence for press/repeat. */
function normalizeKittyFunctionalKey(key: string): string | null | undefined {
	if (!key.startsWith('\x1b[')) return undefined
	// Functional keys end with ~ A-D H F P-S
	const terminator = key[key.length - 1]
	if (!/^[~A-DHFP-S]$/.test(terminator)) return undefined
	const body = key.slice(2, -1)
	// Must contain : (event type) in the modifier field to be a Kitty-enhanced sequence
	if (!body.includes(':')) return undefined
	const fields = body.split(';')
	let eventType = 1
	// Event type is in the last field after ':'
	const lastField = fields[fields.length - 1]
	const colonIdx = lastField.indexOf(':')
	if (colonIdx !== -1) {
		eventType = Number(lastField.slice(colonIdx + 1))
		fields[fields.length - 1] = lastField.slice(0, colonIdx)
	}
	if (eventType === 3) return null // release
	// Reconstruct legacy sequence, stripping default modifiers
	// Remove trailing fields that are just "1" (default modifier)
	while (fields.length > 1 && fields[fields.length - 1] === '1') fields.pop()
	if (fields.length === 1 && fields[0] === '1' && terminator !== '~') fields[0] = ''
	const newBody = fields.join(';')
	return `\x1b[${newBody}${terminator}`
}

/** Parse CSI u (Kitty keyboard protocol) sequences. Returns the legacy key
 *  string for press events, or null to suppress the event (release/modifier-only). */
function normalizeKittyKey(key: string): string | null {
	const csiU = parseKittyCsiUKey(key)
	if (!csiU) {
		const functional = normalizeKittyFunctionalKey(key)
		return functional !== undefined ? functional : key
	}
	const { codepoint, rawModifier, eventType, text } = csiU

	// Track Super/Cmd key state for Cmd+hover
	if (codepoint === SUPER_L || codepoint === SUPER_R) {
		const wasHeld = superHeld
		superHeld = eventType !== 3
		if (wasHeld !== superHeld) updateHoverLink()
		return null
	}

	// Only process press and repeat events (ignore release)
	if (eventType === 3) return null

	// Modifier-only keys (Shift, Ctrl, Alt, etc.) — suppress even with other modifiers held
	if (codepoint >= 0xE000 && codepoint <= 0xF8FF) return null

	const mods = Math.max(0, rawModifier - 1)

	// Super combos: keep as CSI u for handlers that want them
	if ((mods & 8) !== 0) return key

	// Ctrl combos: normalize to legacy control codes
	if ((mods & 4) !== 0 && codepoint >= 0 && codepoint <= 0x7f) {
		const ctrl = String.fromCharCode(codepoint & 0x1f)
		if ((mods & 2) !== 0) return `\x1b${ctrl}` // Alt+Ctrl
		if ((mods & 1) !== 0) return ctrl // Shift+Ctrl (shift doesn't change ctrl code)
		return ctrl
	}

	// Alt combos: ESC prefix
	if ((mods & 2) !== 0 && !(mods & 4) && codepoint >= 0x20 && codepoint <= 0x7e) {
		return `\x1b${String.fromCharCode(codepoint)}`
	}

	// Unmodified special keys → legacy bytes
	if (mods === 0) {
		if (codepoint === 13) return '\r'
		if (codepoint === 9) return '\t'
		if (codepoint === 27) return '\x1b'
		if (codepoint === 127) return '\x7f'
	}

	// Shift-only: Esc and Backspace behave as unmodified; Enter/Tab preserve CSI u
	// so handlers can distinguish Shift+Enter from Enter
	if (mods === 1) {
		if (codepoint === 27) return '\x1b'
		if (codepoint === 127) return '\x7f'
	}

	// Plain or Shift-only printable: prefer associated text (accounts for shift/layout)
	if ((mods === 0 || mods === 1) && (text || codepoint >= 0x20)) {
		return text ?? String.fromCodePoint(codepoint)
	}

	return key
}

export const _testTuiKeys = {
	parseKittyCsiUKey,
	normalizeKittyFunctionalKey,
	normalizeKittyKey,
	resetState(): void {
		hoverOutputRow = -1
		hoverUrl = null
		superHeld = false
		lastMouseX = -1
		lastMouseY = -1
	},
}

// ── Key handler ──

function handleKey(key: string): void {
	const normalizedKitty = normalizeKittyKey(key)
	if (normalizedKitty === null) return
	key = normalizedKitty
	if (inputKeyHandler && inputKeyHandler(key)) return

	// Clipboard shortcuts that reference selection — handle before clearing
	if (handleInputClipboardShortcutKey(key)) return
	if (key === '\x1bw') {
		if (copyCurrentSelectionToClipboard()) render()
		return
	}

	// Any real (non-modifier, non-clipboard) keypress clears output selection
	if (selAnchor) clearSelection()

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
	if (key === '\x1bz') {
		if (undoInputEdit()) render()
		return
	}

	if (key === CTRL_X) {
		if (cutInputTextSelectionToClipboard()) render()
		return
	}
	if (key === CTRL_Y) {
		pasteClipboardIntoInput()
		return
	}
	if (key === '\x1ba' || key === '\x1bA') {
		inputSelAnchor = 0
		inputSelFocus = inputBuf.length
		inputCursor = inputBuf.length
		inputSelActive = false
		render()
		return
	}

	if (key === CTRL_V) {
		pasteClipboardIntoInput()
		return
	}

	// Shift+Enter / Option+Enter: insert newline
	if (key === '\x1b\r' || key === '\x1b\n' || key === '\x1b[13;2u' || key === '\x1b[27;2;13~') {
		insertIntoInput('\n')
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
		clearInputTextSelection()
		clearInputUndoHistory()
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
		if (deleteInputTextSelection()) {
			render()
			return
		}
		if (inputCursor > 0) {
			const b = wordBoundaryLeft(inputBuf, inputCursor)
			replaceInputRange(b, inputCursor, '')
			render()
		}
		return
	}

	// Backspace
	if (key === '\x7f' || key === '\b') {
		if (deleteInputTextSelection()) {
			render()
			return
		}
		if (inputCursor > 0) {
			replaceInputRange(inputCursor - 1, inputCursor, '')
			render()
		}
		return
	}

	// Delete
	if (key === '\x1b[3~') {
		if (deleteInputTextSelection()) {
			render()
			return
		}
		if (inputCursor < inputBuf.length) {
			replaceInputRange(inputCursor, inputCursor + 1, '')
			render()
		}
		return
	}

	// Arrow left / right
	if (key === '\x1b[1;2D') {
		setInputCursor(inputCursor - 1, true)
		render()
		return
	}
	if (key === '\x1b[1;2C') {
		setInputCursor(inputCursor + 1, true)
		render()
		return
	}
	if (key === '\x1b[1;4D') {
		setInputCursor(wordBoundaryLeft(inputBuf, inputCursor), true)
		render()
		return
	}
	if (key === '\x1b[1;4C') {
		setInputCursor(wordBoundaryRight(inputBuf, inputCursor), true)
		render()
		return
	}
	if (key === '\x1b[D' || key === '\x1bOD') {
		if (collapseInputSelection('start')) {
			render()
			return
		}
		if (inputCursor > 0) {
			setInputCursor(inputCursor - 1)
			render()
		}
		return
	}
	if (key === '\x1b[C' || key === '\x1bOC') {
		if (collapseInputSelection('end')) {
			render()
			return
		}
		if (inputCursor < inputBuf.length) {
			setInputCursor(inputCursor + 1)
			render()
		}
		return
	}

	// Opt-left / Opt-right (word jump)
	if (key === '\x1b[1;3D' || key === '\x1bb') {
		if (collapseInputSelection('start')) {
			render()
			return
		}
		setInputCursor(wordBoundaryLeft(inputBuf, inputCursor))
		render()
		return
	}
	if (key === '\x1b[1;3C' || key === '\x1bf') {
		if (collapseInputSelection('end')) {
			render()
			return
		}
		setInputCursor(wordBoundaryRight(inputBuf, inputCursor))
		render()
		return
	}

	// Shift+Home / Shift+End
	if (key === '\x1b[1;2H') {
		setInputCursor(0, true)
		render()
		return
	}
	if (key === '\x1b[1;2F') {
		setInputCursor(inputBuf.length, true)
		render()
		return
	}
	if (key === '\x1b[1;10D') {
		setInputCursor(0, true)
		render()
		return
	}
	if (key === '\x1b[1;10C') {
		setInputCursor(inputBuf.length, true)
		render()
		return
	}

	// Home / Ctrl-A
	if (
		key === '\x1b[H' ||
		key === '\x1bOH' ||
		key === '\x01' ||
		key === '\x1b[1;9D'
	) {
		setInputCursor(0)
		render()
		return
	}
	// End / Ctrl-E
	if (
		key === '\x1b[F' ||
		key === '\x1bOF' ||
		key === '\x05' ||
		key === '\x1b[1;9C'
	) {
		setInputCursor(inputBuf.length)
		render()
		return
	}

	// Ctrl-U / Ctrl-K
	if (key === CTRL_U) {
		if (deleteInputTextSelection()) {
			render()
			return
		}
		replaceInputRange(0, inputCursor, '')
		render()
		return
	}
	if (key === CTRL_K) {
		if (deleteInputTextSelection()) {
			render()
			return
		}
		replaceInputRange(inputCursor, inputBuf.length, '')
		render()
		return
	}

	// Arrow up
	if (key === '\x1b[A' || key === '\x1bOA') {
		clearInputTextSelection()
		const contentWidth = cols() - 1 - inputPromptStr.length
		const { row, col } = cursorToWrappedRowCol(inputBuf, inputCursor, contentWidth)
		if (row > 0) {
			inputCursor = wrappedRowColToCursor(inputBuf, row - 1, col, contentWidth)
			render()
			return
		}
		if (inputHistory.length === 0) return
		if (historyIndex < 0) {
			historyDraft = inputBuf
			historyIndex = inputHistory.length - 1
		} else if (historyIndex > 0) historyIndex--
		else return
		setInputTextWithUndo(inputHistory[historyIndex])
		render()
		return
	}

	// Arrow down
	if (key === '\x1b[B' || key === '\x1bOB') {
		clearInputTextSelection()
		const contentWidth = cols() - 1 - inputPromptStr.length
		const { lines } = getWrappedInputLayout(inputBuf, contentWidth)
		const { row, col } = cursorToWrappedRowCol(inputBuf, inputCursor, contentWidth)
		if (row < lines.length - 1) {
			inputCursor = wrappedRowColToCursor(inputBuf, row + 1, col, contentWidth)
			render()
			return
		}
		if (historyIndex < 0) return
		if (historyIndex < inputHistory.length - 1) {
			historyIndex++
			setInputTextWithUndo(inputHistory[historyIndex])
		} else {
			historyIndex = -1
			setInputTextWithUndo(historyDraft)
			historyDraft = ''
		}
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
				setInputTextWithUndo(matches[0])
				render()
			} else if (matches.length > 1) {
				let common = matches[0]
				for (let i = 1; i < matches.length; i++) {
					while (common.length > 0 && !matches[i].startsWith(common)) {
						common = common.slice(0, -1)
					}
				}
				if (common.length > inputBuf.length) {
					setInputTextWithUndo(common)
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
			insertIntoInput(ch)
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
		insertIntoInput(ref)
	} else {
		const clean = key.replace(/[\x00-\x1f]/g, '')
		if (!clean) return
		insertIntoInput(clean)
	}
	render()
}

// ── Stdin processing ──

function flushStdinBuffer(): void {
	const data = stdinBuffer
	stdinBuffer = ''
	stdinTimer = null
	logKeypress(data)

	// Selection clearing moved into handleKey (per-key, after modifier/clipboard filtering)

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

			if (baseButton === 64) scrollDelta += 1
			else if (baseButton === 65) scrollDelta -= 1
			else if (baseButton === 0) {
				handleMouseEvent(x - 1, y - 1, isRelease ? 'release' : isMove ? 'move' : 'press')
			} else if (baseButton === 3 && isMove) {
				handleMouseEvent(x - 1, y - 1, 'move')
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
	const wasAtBottom = scrollOffset === 0
	const prevTotalVisual = getTotalVisualLines()
	appendOutput(text)
	const nextTotalVisual = getTotalVisualLines()
	const addedLines = nextTotalVisual - prevTotalVisual
	if (wasAtBottom) {
		scrollOffset = 0 // stay at bottom
		// Viewport shifts down — adjust selection rows up
		if (selAnchor && selAnchor.surface === 'output') {
			selAnchor = { ...selAnchor, row: selAnchor.row - addedLines }
			if (selCurrent) selCurrent = { ...selCurrent, row: selCurrent.row - addedLines }
			// Clear if selection scrolled out of view
			if ((selCurrent && selCurrent.row < 0) || selAnchor.row < 0) {
				selAnchor = null
				selCurrent = null
				selActive = false
			}
		}
	} else {
		// Scrolled up — scroll offset compensates, viewport unchanged, selection stays valid
		scrollOffset = Math.max(0, scrollOffset + addedLines)
	}
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
	clearInputTextSelection()
	clearInputUndoHistory()
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
	clearInputTextSelection()
	clearInputUndoHistory()
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
