/**
 * Terminal UI with raw mode input and managed footer.
 *
 * Layout:
 *   Rows 1..(rows - footerH)   = output (scroll region, append-only)
 *   Row  (rows - footerH + 1)  = activity line (dim, what the model is doing)
 *   Row  (rows - footerH + 2)  = status line (dashes with tabs + context)
 *   Row  (rows - footerH + 3)  = empty dark-grey line
 *   Rows ...                    = prompt text lines (dark-grey bg)
 *   Row  rows                   = empty dark-grey line
 *
 * Footer height = 1 (activity) + 1 (status) + 1 (pad top) + promptLines + 1 (pad bottom)
 *               = 4 + promptLines  (min 5 when promptLines=1)
 */

import { stringify } from '../utils/ason.ts'
import { pasteFromClipboard, saveMultilinePaste } from './clipboard.ts'
import { logKeypress } from '../debug-log.ts'
export { stripAnsi } from './format/index.ts'

// Control key constants
export const CTRL_C = '\x03'

const CTRL_D = '\x04'
const CTRL_K = '\x0b'
const CTRL_U = '\x15'
const CTRL_V = '\x16'
const CTRL_Z = '\x1a'

type TabCompleter = (prefix: string) => string[]
type InputKeyHandler = (key: string) => boolean | void
type InputEchoFilter = (value: string) => boolean

let tabCompleter: TabCompleter | null = null
let inputKeyHandler: InputKeyHandler | null = null
let inputEchoFilter: InputEchoFilter | null = null

export function setTabCompleter(fn: TabCompleter): void {
	tabCompleter = fn
}
export function setInputKeyHandler(handler: InputKeyHandler | null): void {
	inputKeyHandler = handler
}
export function setInputEchoFilter(handler: InputEchoFilter | null): void {
	inputEchoFilter = handler
}

export function getInputHistory(): string[] {
	return inputHistory
}
export function setInputHistory(history: string[]): void {
	inputHistory = history
	historyIndex = -1
	historyDraft = ''
}

function safeStringify(value: unknown): string {
	if (typeof value === 'string') return value
	try {
		return stringify(value)
	} catch {
		return String(value)
	}
}

// Footer geometry
let maxPromptLines = 15

export function setMaxPromptLines(n: number): void {
	maxPromptLines = Math.max(1, Math.min(n, 50))
}

let initialized = false
let ended = false
let suspended = false
let transcript = ''

// Activity line content (what the model is doing)
let activityStr = ''

// Status line content (dash line with tabs + context)
let statusTabsStr = ''
let statusRightStr = ''

let outputCursorRow = 1
let outputCursorSaved = false

let inputBuf = ''
let inputCursor = 0
let inputPromptStr = '> '
let inputHistory: string[] = []
let historyIndex = -1
let historyDraft = ''
let waitingResolve: ((value: string | null) => void) | null = null

let escHandler: (() => void) | null = null
let doubleEnterHandler: (() => void) | null = null
let lastSubmitTime = 0
let headerFlash = ''
let headerFlashTimer: ReturnType<typeof setTimeout> | null = null

function cols(): number {
	return process.stdout.columns || 80
}
function rows(): number {
	return process.stdout.rows || 24
}

// Dark grey background
const BG_DARK = '\x1b[48;5;236m'
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const STATUS_DIM = '\x1b[38;5;242m'

function rawWrite(text: string): void {
	process.stdout.write(text.replace(/\n/g, '\r\n'))
}
function directWrite(text: string): void {
	process.stdout.write(text)
}

function setScrollRegion(top: number, bottom: number): void {
	directWrite(`\x1b[${top};${bottom}r`)
}
function resetScrollRegion(): void {
	directWrite(`\x1b[r`)
}
function moveTo(row: number, col: number): void {
	directWrite(`\x1b[${row};${col}H`)
}
function clearLine(): void {
	directWrite(`\x1b[2K`)
}
function hideCursor(): void {
	directWrite(`\x1b[?25l`)
}
function showCursor(): void {
	directWrite(`\x1b[?25h`)
}
function saveCursor(): void {
	directWrite(`\x1b7`)
}
function restoreCursor(): void {
	directWrite(`\x1b8`)
}

/** Word-wrap a string into lines of at most `width` chars, breaking at spaces */
function wordWrapLines(text: string, width: number): string[] {
	if (width <= 0) return [text]
	const result: string[] = []
	// Split on explicit newlines first, then word-wrap each line
	for (const segment of text.split('\n')) {
		let remaining = segment
		while (remaining.length > width) {
			let breakAt = remaining.lastIndexOf(' ', width)
			if (breakAt <= 0) breakAt = width // no space found, hard break
			result.push(remaining.slice(0, breakAt))
			// skip the space at the break point if we broke at a space
			remaining =
				remaining[breakAt] === ' ' ? remaining.slice(breakAt + 1) : remaining.slice(breakAt)
		}
		result.push(remaining)
	}
	return result
}

/** How many screen lines the current input text occupies (with word wrap) */
function promptLineCount(): number {
	const c = cols()
	if (c <= 0) return 1
	const contentWidth = c - 1 - inputPromptStr.length // right margin + left margin
	const lines = wordWrapLines(inputBuf, contentWidth)
	return Math.max(1, Math.min(lines.length, maxPromptLines))
}

/** Total footer height: activity(1) + status(1) + padTop(1) + promptLines + padBottom(1) */
function footerHeight(): number {
	return 4 + promptLineCount()
}

let lastFooterH = 0

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
function promptBottomPadRow(): number {
	return rows()
}

function setupScrollRegion(): void {
	const fh = footerHeight()
	lastFooterH = fh
	setScrollRegion(1, outputBottom())
}

/** Build the status line with box-drawing chars: ─[tab1]── Context: X% / 200k ─ */
function buildStatusLine(): string {
	const c = cols()
	const left = statusTabsStr
	const right = headerFlash || statusRightStr
	const rightPart = right ? ` ${right} ─` : ' ─'
	const leftPart = left ? `─${left}─` : '─'
	const dashCount = Math.max(0, c - leftPart.length - rightPart.length)
	const line = leftPart + '─'.repeat(dashCount) + rightPart
	return `${STATUS_DIM}${line.slice(0, c)}${RESET}`
}

function drawActivityLine(): void {
	moveTo(activityRow(), 1)
	clearLine()
	const c = cols()
	const text = activityStr ? `  Model: ${activityStr}` : '  Model: Idle'
	directWrite(`${DIM}${text.slice(0, c)}${RESET}`)
}

function drawStatusLine(): void {
	moveTo(statusRow(), 1)
	clearLine()
	directWrite(buildStatusLine())
}

/** Draw a full-width dark-grey empty line at the given row */
function drawDarkPad(row: number): void {
	moveTo(row, 1)
	clearLine()
	directWrite(`${BG_DARK}${' '.repeat(cols())}${RESET}`)
}

function drawPromptLines(): void {
	const c = cols()
	const contentWidth = c - 1 - inputPromptStr.length
	const wrapped = wordWrapLines(inputBuf, contentWidth)
	const pLines = Math.min(wrapped.length, maxPromptLines)
	const firstRow = promptFirstRow()

	for (let i = 0; i < pLines; i++) {
		// Same left margin on all lines (prompt prefix)
		const chunk = inputPromptStr + wrapped[i]
		const padded = chunk + ' '.repeat(Math.max(0, c - chunk.length))
		moveTo(firstRow + i, 1)
		clearLine()
		directWrite(`${BG_DARK}${padded}${RESET}`)
	}
}

/** Map an absolute char offset in the unwrapped text to (row, col) in word-wrapped layout */
function cursorToRowCol(absPos: number, width: number): { row: number; col: number } {
	const wrapped = wordWrapLines(inputBuf, width)
	let charsSoFar = 0
	for (let i = 0; i < wrapped.length; i++) {
		const lineLen = wrapped[i].length
		// account for the break char consumed between wrapped lines (space or newline)
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
	// Past end: last line
	const lastLine = wrapped.length - 1
	return { row: lastLine, col: wrapped[lastLine]?.length ?? 0 }
}

function positionCursorAtInput(): void {
	const c = cols()
	const contentWidth = c - 1 - inputPromptStr.length
	const { row, col } = cursorToRowCol(inputCursor, contentWidth)
	// All lines have the same left margin (inputPromptStr)
	moveTo(promptFirstRow() + row, col + 1 + inputPromptStr.length)
}

/** Clear all footer rows and redraw */
function fullRedrawFooter(): void {
	const r = rows()
	// Clear from status row to bottom of terminal
	for (let row = Math.max(1, r - lastFooterH - 2); row <= r; row++) {
		moveTo(row, 1)
		clearLine()
	}
	const newH = footerHeight()
	lastFooterH = newH
	const bottom = outputBottom()
	if (outputCursorRow > bottom) outputCursorRow = bottom
	setupScrollRegion()

	hideCursor()
	drawActivityLine()
	drawStatusLine()
	drawDarkPad(promptTopPadRow())
	drawPromptLines()
	drawDarkPad(promptBottomPadRow())
	positionCursorAtInput()
	showCursor()
}

function redrawFooter(): void {
	const newH = footerHeight()
	if (newH !== lastFooterH) {
		fullRedrawFooter()
		return
	}

	hideCursor()
	drawActivityLine()
	drawStatusLine()
	drawDarkPad(promptTopPadRow())
	drawPromptLines()
	drawDarkPad(promptBottomPadRow())
	positionCursorAtInput()
	showCursor()
}

export function flashHeader(text: string, durationMs = 1500): void {
	if (headerFlashTimer) clearTimeout(headerFlashTimer)
	headerFlash = text
	if (initialized) redrawFooter()
	headerFlashTimer = setTimeout(() => {
		headerFlash = ''
		headerFlashTimer = null
		if (initialized) redrawFooter()
	}, durationMs)
}

// Key parsing

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
let stdinBuffer = ''
let stdinTimer: ReturnType<typeof setTimeout> | null = null
const STDIN_COALESCE_MS = 50

function parseKeys(data: string): string[] {
	const keys: string[] = []
	let i = 0
	while (i < data.length) {
		if (data.startsWith(PASTE_START, i)) {
			const contentStart = i + PASTE_START.length
			const endIdx = data.indexOf(PASTE_END, contentStart)
			if (endIdx >= 0) {
				const pasted = data.slice(contentStart, endIdx)
				if (pasted) keys.push(pasted)
				i = endIdx + PASTE_END.length
			} else {
				const pasted = data.slice(contentStart)
				if (pasted) keys.push(pasted)
				i = data.length
			}
			continue
		}
		if (data[i] === '\x1b') {
			if (i + 1 < data.length && (data[i + 1] === '[' || data[i + 1] === 'O')) {
				let j = i + 2
				while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x3f)
					j++
				if (j < data.length) j++
				keys.push(data.slice(i, j))
				i = j
			} else if (i + 1 < data.length) {
				keys.push(data.slice(i, i + 2))
				i += 2
			} else {
				keys.push('\x1b')
				i++
			}
		} else {
			keys.push(data[i])
			i++
		}
	}
	return keys
}

function wordBoundaryLeft(buf: string, cursor: number): number {
	let i = cursor
	while (i > 0 && buf[i - 1] === ' ') i--
	while (i > 0 && buf[i - 1] !== ' ') i--
	return i
}

function wordBoundaryRight(buf: string, cursor: number): number {
	let i = cursor
	while (i < buf.length && buf[i] !== ' ') i++
	while (i < buf.length && buf[i] === ' ') i++
	return i
}

function suspendForegroundJob(): void {
	suspended = true
	directWrite('\x1b[?2004l')
	resetScrollRegion()
	if (process.stdin.isTTY) process.stdin.setRawMode(false)
	try {
		process.kill(0, 'SIGSTOP')
	} catch {
		process.kill(process.pid, 'SIGSTOP')
	}
}

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
			inputBuf = inputBuf.slice(0, inputCursor) + clean + inputBuf.slice(inputCursor)
			inputCursor += clean.length
			redrawFooter()
		})
		return
	}

	// Shift+Enter / Option+Enter: insert newline
	// \x1b\r = Option+Enter (macOS), \x1b\n = Alt+Enter variant
	// \x1b[13;2u = Shift+Enter (kitty protocol), \x1b[27;2;13~ = Shift+Enter (xterm modifyOtherKeys)
	if (key === '\x1b\r' || key === '\x1b\n' || key === '\x1b[13;2u' || key === '\x1b[27;2;13~') {
		inputBuf = inputBuf.slice(0, inputCursor) + '\n' + inputBuf.slice(inputCursor)
		inputCursor++
		redrawFooter()
		return
	}

	if (key === '\r' || key === '\n') {
		const value = inputBuf
		const now = Date.now()

		// Double-enter: empty buffer shortly after a submit → steer
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
		redrawFooter()
		if (waitingResolve) {
			const r = waitingResolve
			waitingResolve = null
			r(value)
		}
		return
	}

	if (key === '\x1b\x7f') {
		if (inputCursor > 0) {
			const b = wordBoundaryLeft(inputBuf, inputCursor)
			inputBuf = inputBuf.slice(0, b) + inputBuf.slice(inputCursor)
			inputCursor = b
			redrawFooter()
		}
		return
	}

	if (key === '\x7f' || key === '\b') {
		if (inputCursor > 0) {
			inputBuf = inputBuf.slice(0, inputCursor - 1) + inputBuf.slice(inputCursor)
			inputCursor--
			redrawFooter()
		}
		return
	}

	if (key === '\x1b[3~') {
		if (inputCursor < inputBuf.length) {
			inputBuf = inputBuf.slice(0, inputCursor) + inputBuf.slice(inputCursor + 1)
			redrawFooter()
		}
		return
	}

	// Arrow left / right
	if (key === '\x1b[D' || key === '\x1bOD') {
		if (inputCursor > 0) {
			inputCursor--
			redrawFooter()
		}
		return
	}
	if (key === '\x1b[C' || key === '\x1bOC') {
		if (inputCursor < inputBuf.length) {
			inputCursor++
			redrawFooter()
		}
		return
	}

	// Opt-left / Opt-right (word jump) — \x1b[1;3D / \x1b[1;3C or \x1bb / \x1bf
	if (key === '\x1b[1;3D' || key === '\x1bb') {
		inputCursor = wordBoundaryLeft(inputBuf, inputCursor)
		redrawFooter()
		return
	}
	if (key === '\x1b[1;3C' || key === '\x1bf') {
		inputCursor = wordBoundaryRight(inputBuf, inputCursor)
		redrawFooter()
		return
	}

	// Cmd-left / Cmd-right (line start/end) — various sequences across terminals
	// \x1b[1;2D = Shift-Left (some terminals map Cmd-Left here)
	// \x1b[1;9D = Cmd-Left in some kitty/iTerm configs
	// \x1b[H / \x1bOH = Home, \x1b[F / \x1bOF = End
	// Ctrl-A / Ctrl-E = Home / End
	if (
		key === '\x1b[H' ||
		key === '\x1bOH' ||
		key === '\x01' ||
		key === '\x1b[1;9D' ||
		key === '\x1b[1;2D'
	) {
		inputCursor = 0
		redrawFooter()
		return
	}
	if (
		key === '\x1b[F' ||
		key === '\x1bOF' ||
		key === '\x05' ||
		key === '\x1b[1;9C' ||
		key === '\x1b[1;2C'
	) {
		inputCursor = inputBuf.length
		redrawFooter()
		return
	}

	// Ctrl-U / Ctrl-K
	if (key === CTRL_U) {
		inputBuf = inputBuf.slice(inputCursor)
		inputCursor = 0
		redrawFooter()
		return
	}

	if (key === CTRL_K) {
		inputBuf = inputBuf.slice(0, inputCursor)
		redrawFooter()
		return
	}

	if (key === '\x1b[A' || key === '\x1bOA') {
		// If multi-line and not on first line, move cursor up
		if (inputBuf.includes('\n')) {
			const pos = inputCursor
			// Find start of current line
			const lineStart = inputBuf.lastIndexOf('\n', pos - 1)
			if (lineStart >= 0) {
				// There's a line above — move up
				const colInLine = pos - lineStart - 1
				const prevLineStart = inputBuf.lastIndexOf('\n', lineStart - 1) + 1
				const prevLineLen = lineStart - prevLineStart
				inputCursor = prevLineStart + Math.min(colInLine, prevLineLen)
				redrawFooter()
				return
			}
		}
		// First line or single-line: history navigation
		if (inputHistory.length === 0) return
		if (historyIndex < 0) {
			historyDraft = inputBuf
			historyIndex = inputHistory.length - 1
		} else if (historyIndex > 0) historyIndex--
		else return
		inputBuf = inputHistory[historyIndex]
		inputCursor = inputBuf.length
		redrawFooter()
		return
	}

	if (key === '\x1b[B' || key === '\x1bOB') {
		// If multi-line and not on last line, move cursor down
		if (inputBuf.includes('\n')) {
			const pos = inputCursor
			const nextNewline = inputBuf.indexOf('\n', pos)
			if (nextNewline >= 0) {
				// There's a line below — move down
				const lineStart = inputBuf.lastIndexOf('\n', pos - 1) + 1
				const colInLine = pos - lineStart
				const nextLineStart = nextNewline + 1
				const nextNextNewline = inputBuf.indexOf('\n', nextLineStart)
				const nextLineLen =
					(nextNextNewline >= 0 ? nextNextNewline : inputBuf.length) - nextLineStart
				inputCursor = nextLineStart + Math.min(colInLine, nextLineLen)
				redrawFooter()
				return
			}
		}
		// Last line or single-line: history navigation
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
		redrawFooter()
		return
	}

	if (key === '\t') {
		if (tabCompleter) {
			const matches = tabCompleter(inputBuf)
			if (matches.length === 1) {
				inputBuf = matches[0]
				inputCursor = inputBuf.length
				redrawFooter()
			} else if (matches.length > 1) {
				// Complete common prefix
				let common = matches[0]
				for (let i = 1; i < matches.length; i++) {
					while (common.length > 0 && !matches[i].startsWith(common)) {
						common = common.slice(0, -1)
					}
				}
				if (common.length > inputBuf.length) {
					inputBuf = common
					inputCursor = inputBuf.length
					redrawFooter()
				}
			}
		}
		return
	}

	if (key === '\x1b') {
		if (escHandler) escHandler()
		return
	}

	if (key.length === 1 && key.charCodeAt(0) < 0x20) return

	// Decode xterm modifyOtherKeys: \x1b[27;<modifier>;<charcode>~ → character
	// modifier 2 = Shift, but the charcode already reflects the shift state
	const modifyOtherKeys = key.match(/^\x1b\[27;\d+;(\d+)~$/)
	if (modifyOtherKeys) {
		const ch = String.fromCharCode(Number(modifyOtherKeys[1]))
		if (ch) {
			inputBuf = inputBuf.slice(0, inputCursor) + ch + inputBuf.slice(inputCursor)
			inputCursor += ch.length
			redrawFooter()
		}
		return
	}

	if (key.startsWith('\x1b')) return

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
	redrawFooter()
}

function flushStdinBuffer(): void {
	const data = stdinBuffer
	stdinBuffer = ''
	stdinTimer = null
	logKeypress(data)
	for (const key of parseKeys(data)) handleKey(key)
}

const onStdinData = (chunk: Buffer | string) => {
	const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
	if (!text) return
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

function writeToOutput(text: string): void {
	if (!text) return
	hideCursor()
	if (outputCursorSaved) restoreCursor()
	else {
		moveTo(outputCursorRow, 1)
		outputCursorSaved = true
	}
	rawWrite(text)
	const newlines = (text.match(/\n/g) || []).length
	if (newlines > 0) outputCursorRow = Math.min(outputCursorRow + newlines, outputBottom())
	saveCursor()
	redrawFooter()
	showCursor()
	transcript += text
}

function onResize(): void {
	if (!initialized || suspended) return

	// Reset scroll region so we can write anywhere
	resetScrollRegion()

	// Clear entire screen
	moveTo(1, 1)
	directWrite('\x1b[J')

	// Set up new scroll region for the resized terminal
	setupScrollRegion()

	// Rewrite visible output from transcript
	outputCursorRow = 1
	outputCursorSaved = false
	if (transcript) {
		const bottom = outputBottom()
		// Take the tail of the transcript that fits on screen
		const lines = transcript.split('\n')
		// We want at most `bottom` lines (the output area height)
		const visibleLines = lines.slice(-bottom)
		const visible = visibleLines.join('\n')
		moveTo(1, 1)
		rawWrite(visible)
		outputCursorRow = Math.min(visibleLines.length, bottom)
		saveCursor()
		outputCursorSaved = true
	}

	fullRedrawFooter()
}

function enterRawMode(): void {
	process.stdin.setEncoding('utf8')
	if (process.stdin.isTTY) process.stdin.setRawMode(true)
	process.stdin.resume()
}

function onSigCont(): void {
	suspended = false
	ended = false
	enterRawMode()
	directWrite('\x1b[?2004h')
	setupScrollRegion()
	redrawFooter()
}

export function init(): void {
	if (initialized) return
	initialized = true
	ended = false
	suspended = false
	inputBuf = ''
	inputCursor = 0
	outputCursorRow = 1
	outputCursorSaved = false
	lastFooterH = 0

	enterRawMode()
	directWrite('\x1b[?2004h')
	process.stdin.on('data', onStdinData)
	process.stdin.on('end', onStdinEnd)
	process.on('SIGCONT', onSigCont)
	process.stdout.on('resize', onResize)

	setupScrollRegion()
	redrawFooter()
}

export function write(text: string): void {
	writeToOutput(text)
}

export function log(...args: any[]): void {
	write(args.map((a) => safeStringify(a)).join(' ') + '\n')
}

/** Set the activity line content (what the model is doing) */
export function setActivityLine(text: string): void {
	if (activityStr === text) return
	activityStr = text
	if (initialized) redrawFooter()
}

/** Set the status line content. tabsStr = formatted tab names, rightStr = context info */
export function setStatusLine(tabsStr: string, rightStr: string): void {
	statusTabsStr = tabsStr
	statusRightStr = rightStr
	if (initialized) redrawFooter()
}

// Keep old API for compatibility — maps to setStatusLine
export function setHeader(text: string): void {
	statusTabsStr = text
	if (initialized) redrawFooter()
}
export function setStatus(text: string, _rightText = ''): void {
	statusRightStr = text ? text + (_rightText ? `  ${_rightText}` : '') : _rightText
	if (initialized) redrawFooter()
}

export function getOutputSnapshot(): string {
	return transcript
}
export function setOutputSnapshot(snapshot: string): void {
	transcript = snapshot
}

export function clearOutput(): void {
	transcript = ''
	outputCursorRow = 1
	outputCursorSaved = false
	if (process.stdout.isTTY) {
		const bottom = outputBottom()
		for (let r = 1; r <= bottom; r++) {
			moveTo(r, 1)
			clearLine()
		}
	}
	redrawFooter()
}

export function replaceOutput(snapshot: string): void {
	clearOutput()
	if (snapshot) writeToOutput(snapshot)
}

export function setEscHandler(handler: (() => void) | null): void {
	escHandler = handler
}
export function setDoubleEnterHandler(handler: (() => void) | null): void {
	doubleEnterHandler = handler
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
	redrawFooter()
	if (ended) return Promise.resolve(null)
	return new Promise((resolve) => {
		waitingResolve = resolve
	})
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
	directWrite('\x1b[?2004l')
	resetScrollRegion()
	showCursor()
	moveTo(rows(), 1)
	directWrite('\r\n')
	if (process.stdin.isTTY) process.stdin.setRawMode(false)
	process.stdin.off('data', onStdinData)
	process.stdin.off('end', onStdinEnd)
	process.off('SIGCONT', onSigCont)
	process.stdout.off('resize', onResize)
	if (waitingResolve) {
		const r = waitingResolve
		waitingResolve = null
		r(null)
	}
}
