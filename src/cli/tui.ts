// State-driven terminal UI with alternate screen buffer. See docs/tui.md.

import { stringify } from '../utils/ason.ts'
import { getConfig } from '../config.ts'
import { pasteFromClipboard, saveMultilinePaste } from './clipboard.ts'
import { logKeypress } from '../debug-log.ts'
import { linkifyLine, normalizeDetectedUrl, underlineOsc8Link, urlAtCol } from './tui-links.ts'
import { expandTabs, parseKeys, readEscapeSequence, truncateAnsi, wrapAnsi, wordBoundaryLeft, wordBoundaryRight, wordWrapLines } from './tui-text.ts'
import { cursorToWrappedRowCol, getWrappedInputLayout, wrappedRowColToCursor, verticalMove } from './tui-input-layout.ts'
export { stripAnsi } from './format/index.ts'
import { stripAnsi } from './format/index.ts'
import { buildStatusBarLine } from './tui/format/status-bar.ts'

// ── Constants ──

export const CTRL_C = '\x03'
const CTRL_D = '\x04', CTRL_K = '\x0b', CTRL_U = '\x15'
const CTRL_V = '\x16', CTRL_X = '\x18', CTRL_Y = '\x19', CTRL_Z = '\x1a'
const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~'
const MAX_OUTPUT_LINES = 10_000
const BG_DARK = '\x1b[48;5;236m', RESET = '\x1b[0m', DIM = '\x1b[2m', ERASE_TO_EOL = '\x1b[K'
const CURSOR_RESET = '\x1b]112\x07\x1b[0 q'
const CURSOR_BLUE_OSC = '\x1b]12;rgb:66/bb/ff\x07'
const CURSOR_GREY_OSC = '\x1b]12;rgb:88/88/88\x07'
const ANIM_MS = 50
const TITLE_BG = '\x1b[48;5;238m', TITLE_TOPIC = '\x1b[38;5;245m', TITLE_SESSION = '\x1b[38;5;252m'
const KITTY_KEYBOARD_ENABLE = '\x1b[>27u', KITTY_KEYBOARD_DISABLE = '\x1b[<u'
// ── Types ──

type TabCompleter = (prefix: string) => string[]
type InputKeyHandler = (key: string) => boolean | void
type InputEchoFilter = (value: string) => boolean
type SelectionSurface = 'title' | 'output' | 'activity' | 'status' | 'input'
type SelectionPoint = { surface: SelectionSurface; row: number; col: number }
type SelectionRange = { surface: SelectionSurface; startRow: number; startCol: number; endRow: number; endCol: number }
type SelectionMode = 'char' | 'word' | 'line'
type InputUndoSnapshot = { text: string; cursor: number; selAnchor: number | null; selFocus: number | null }

let tabCompleter: TabCompleter | null = null, inputKeyHandler: InputKeyHandler | null = null
let inputEchoFilter: InputEchoFilter | null = null, escHandler: (() => void) | null = null
let doubleEnterHandler: (() => void) | null = null
export function setTabCompleter(fn: TabCompleter): void { tabCompleter = fn }
export function setInputKeyHandler(handler: InputKeyHandler | null): void { inputKeyHandler = handler }
export function setInputEchoFilter(handler: InputEchoFilter | null): void { inputEchoFilter = handler }
export function setEscHandler(handler: (() => void) | null): void { escHandler = handler }
export function setDoubleEnterHandler(handler: (() => void) | null): void { doubleEnterHandler = handler }

let inputHistory: string[] = [], historyIndex = -1, historyDraft = ''
export function getInputHistory(): string[] { return inputHistory }
export function setInputHistory(history: string[]): void { inputHistory = history; historyIndex = -1; historyDraft = '' }
export function getInputDraft(): { text: string; cursor: number } { return { text: inputBuf, cursor: inputCursor } }
export function setInputDraft(text: string, cursor?: number): void {
	inputBuf = text; inputCursor = cursor ?? text.length
	clearInputTextSelection(); clearInputUndoHistory()
	historyIndex = -1; historyDraft = ''; draftPreloaded = !!text
}
let maxPromptLines = 15
export function setMaxPromptLines(n: number): void { maxPromptLines = Math.max(1, Math.min(n, 50)) }
let userCursorMode: 'native' | 'block' = 'block'
export function setUserCursorMode(mode: 'native' | 'block'): void { userCursorMode = mode }

// ── Core state ──

let initialized = false, ended = false, suspended = false
let outputLines: string[] = [''], scrollOffset = 0, wrappedLineCount = 1, lastWrapCols = 0
let titleBarStr = '', activityStr = '', statusTabsStr = '', statusRightStr = ''
let headerFlash = '', headerFlashTimer: ReturnType<typeof setTimeout> | null = null
let inputBuf = '', inputCursor = 0, inputGoalCol: number | null = null, inputPromptStr = '> '
let inputSelAnchor: number | null = null, inputSelFocus: number | null = null, inputSelActive = false
let inputUndoStack: InputUndoSnapshot[] = [], draftPreloaded = false
let waitingResolve: ((value: string | null) => void) | null = null, lastSubmitTime = 0
let selAnchor: SelectionPoint | null = null, selCurrent: SelectionPoint | null = null
let selMode: SelectionMode = 'char', selActive = false
let lastClickTime = 0, lastClickPos: SelectionPoint | null = null, clickCount = 0
let lastVisibleOutput: string[] = [], lastActivityLine = '', lastStatusLine = '', lastTitleLine = ''
let hoverOutputRow = -1, hoverUrl: string | null = null
let superHeld = false, lastMouseX = -1, lastMouseY = -1
let bracketedPasteBuffer: string | null = null
let stdinBuffer = '', stdinTimer: ReturnType<typeof setTimeout> | null = null
const STDIN_COALESCE_MS = 50
type CursorAnim = { phase: number; period: number; shrinkStart: number | null; brightSince: number | null }
function makeCursorAnim(period: number): CursorAnim { return { phase: 0, period, shrinkStart: null, brightSince: null } }
function resetShrink(c: CursorAnim): void { c.shrinkStart = null; c.brightSince = null }
function tickShrink(c: CursorAnim, delay: number, idleMs: number, now: number): void {
	if (c.shrinkStart !== null) return
	if (idleMs < delay) return
	if (brightness(c.phase) === 1) {
		if (c.brightSince === null) c.brightSince = now
		else if (now - c.brightSince >= IDLE_SHRINK_BRIGHT_HOLD) c.shrinkStart = now
	} else {
		c.brightSince = null
	}
}
const hal = makeCursorAnim(1000)
let userPhase = 0
let userPeriodCurrent = 500
let halIntensity = 0.5 // 1.0 when busy, 0.5 when idle
let animTimer: ReturnType<typeof setInterval> | null = null
let windowFocused = true
const SHRINK_BLOCKS = '\u2588\u2587\u2586\u2585\u2584\u2583\u2582\u2581' // █▇▆▅▄▃▂▁
const IDLE_SHRINK_DURATION = 250 // ms for shrink animation
const IDLE_SHRINK_BRIGHT_HOLD = 100 // ms cursor must be fully bright before shrink starts
function brightness(phase: number): number {
	// ~43% on, 7% fade out, ~43% off, 7% fade in
	if (phase < 0.43) return 1
	if (phase < 0.50) return 1 - (phase - 0.43) / 0.07
	if (phase < 0.93) return 0
	return (phase - 0.93) / 0.07
}
function shrinkChar(c: CursorAnim): string {
	if (c.shrinkStart === null) return SHRINK_BLOCKS[0]
	const t = Math.min((Date.now() - c.shrinkStart) / IDLE_SHRINK_DURATION, 1)
	return SHRINK_BLOCKS[Math.round(t * (SHRINK_BLOCKS.length - 1))]
}
function isDormant(c: CursorAnim): boolean { return c.shrinkStart !== null && Date.now() - c.shrinkStart >= IDLE_SHRINK_DURATION }
function lerpCh(to: number, t: number, from = 0): number { return Math.round(from + (to - from) * t) }

// Nudge a phase toward the global clock (Date.now() % period). Shortest-path on circular [0,1).
const DRIFT_RATE = 0.02 // fraction of error corrected per 50ms tick (~2.5s to fully sync)
function driftToGlobalClock(phase: number, period: number, now: number): number {
	let d = (now % period) / period - phase
	if (d > 0.5) d -= 1; if (d < -0.5) d += 1
	return (phase + d * DRIFT_RATE + 1) % 1
}
// --- Per-tab cursor state ---
// Tracks agent state per session so tab switches show the correct cursor.
// States: idle/writing → orange, thinking/tool_call → grey, error → red (instant, sticky 30s).
// Color transitions: 200ms linear interpolation, except error which snaps instantly.
// Error also triggers busy animation speed, which decays naturally to idle.
export type HalState = 'idle' | 'thinking' | 'writing' | 'tool_call' | 'error'
export type BlinkTier = 'busy' | 'idle' | 'dormant'
type RGB = [number, number, number]
const CURSOR_COLORS: Record<HalState, RGB> = {
	idle: [255, 165, 0], thinking: [150, 150, 150], writing: [255, 165, 0],
	tool_call: [180, 100, 255], error: [255, 50, 50],
}
const COLOR_MS = 200
const ERROR_STICKY_MS = 30_000
const TAB_GREY_MS = 20_000 // idle→grey transition for tab dot
const TAB_GREY: RGB = [100, 100, 100]

interface TabCursor {
	state: HalState; errorSince: number; idleSince: number
	ccFrom: RGB; ccTo: RGB; ccStart: number
}
const tabCursors = new Map<string, TabCursor>()
let activeTabCursorId = ''

function makeTabCursor(): TabCursor {
	return { state: 'idle', errorSince: 0, idleSince: 0, ccFrom: [255, 165, 0], ccTo: [255, 165, 0], ccStart: 0 }
}
function tc(): TabCursor {
	let t = tabCursors.get(activeTabCursorId)
	if (!t) { t = makeTabCursor(); tabCursors.set(activeTabCursorId, t) }
	return t
}

export function setActiveTabCursor(id: string): void { activeTabCursorId = id }
export function getTabTier(id: string): BlinkTier {
	const t = tabCursors.get(id)
	if (!t) return 'dormant'
	if (t.state !== 'idle' && t.state !== 'error') return 'busy'
	return (Date.now() - t.idleSince >= getConfig().cursorDormantDelay) ? 'dormant' : 'idle'
}
export function getTabColor(id: string): RGB {
	const t = tabCursors.get(id)
	if (!t) return TAB_GREY
	const rgb = tabCursorRGB(t)
	const idle = t.state === 'idle' || t.state === 'error'
	if (!idle) return rgb
	const fadeStart = t.idleSince + TAB_GREY_MS
	const elapsed = Date.now() - fadeStart
	if (elapsed <= 0) return rgb
	const p = Math.min(elapsed / COLOR_MS, 1)
	return [lerpCh(TAB_GREY[0], p, rgb[0]), lerpCh(TAB_GREY[1], p, rgb[1]), lerpCh(TAB_GREY[2], p, rgb[2])]
}

function tabCursorRGB(t: TabCursor): RGB {
	const p = Math.min((Date.now() - t.ccStart) / COLOR_MS, 1)
	return [lerpCh(t.ccTo[0], p, t.ccFrom[0]), lerpCh(t.ccTo[1], p, t.ccFrom[1]), lerpCh(t.ccTo[2], p, t.ccFrom[2])]
}
function cursorRGB(): RGB { return tabCursorRGB(tc()) }

export function setHalState(state: HalState, tabId = activeTabCursorId): void {
	let t = tabCursors.get(tabId)
	if (!t) { t = makeTabCursor(); tabCursors.set(tabId, t) }
	const isActiveTab = tabId === activeTabCursorId
	if (t.state === 'error' && state === 'idle' && Date.now() - t.errorSince < ERROR_STICKY_MS) {
		setTimeout(() => { if (tabCursors.get(tabId) === t && t.state === 'error') setHalState('idle', tabId) },
			ERROR_STICKY_MS - (Date.now() - t.errorSince))
		return
	}
	const wasState = t.state
	t.state = state
	// only snap speed on *new* error, not tab-switch re-apply
	if (state === 'error' && wasState !== 'error') {
		t.errorSince = Date.now()
		if (isActiveTab) { hal.period = getConfig().cursorBlinkBusy; halIntensity = 1.0 }
	}
	const target = CURSOR_COLORS[state]
	if (target[0] !== t.ccTo[0] || target[1] !== t.ccTo[1] || target[2] !== t.ccTo[2]) {
		// snap instantly to non-idle colors; smooth 200ms transition back to idle
		t.ccFrom = state === 'idle' ? tabCursorRGB(t) : target
		t.ccTo = target; t.ccStart = Date.now()
	}
	// error → busy speed; idle → start decay; other → busy
	if (state !== 'idle') {
		t.idleSince = Infinity
	} else if (wasState !== 'idle') {
		t.idleSince = Date.now()
	} else return
	// only reset the global cursor animation when updating the active tab
	if (isActiveTab) resetShrink(hal)
}

export function getHalIdleSince(): number { return tc().idleSince }
export function restoreHalIdleTimer(ts: number): void {
	tc().idleSince = ts
	if (Date.now() - ts >= getConfig().cursorDormantDelay) {
		hal.shrinkStart = ts; hal.brightSince = null
	} else {
		resetShrink(hal)
	}
}
export function resetHalIdleTimer(): void {
	tc().idleSince = Date.now()
	resetShrink(hal)
}

const RAMP_RATE = 0.98
function animTick(): void {
	const cfg = getConfig()
	const t = tc()
	const isIdle = t.state === 'idle'
	const isError = t.state === 'error'
	const now = Date.now()
	const idleMs = now - t.idleSince
	// error: target idle speed (ramp down from busy snap), never go dormant
	const halTarget = (!isError && isDormant(hal)) ? cfg.cursorBlinkDormant
		: (isIdle || isError) ? cfg.cursorBlinkIdle : cfg.cursorBlinkBusy
	const intensityTarget = (isIdle || isError) ? 0.5 : 1.0
	hal.period += (halTarget - hal.period) * (1 - RAMP_RATE)
	hal.phase = (hal.phase + ANIM_MS / hal.period) % 1
	halIntensity += (intensityTarget - halIntensity) * (1 - RAMP_RATE)
	const userPeriod = windowFocused ? cfg.cursorBlinkUser : cfg.cursorBlinkUser * 2
	userPhase = (userPhase + ANIM_MS / userPeriod) % 1
	// slowly drift both cursors toward Date.now()-based clock (syncs with tab indicators)
	hal.phase = driftToGlobalClock(hal.phase, hal.period, now)
	userPhase = driftToGlobalClock(userPhase, userPeriod, now)
	if (isIdle) tickShrink(hal, cfg.cursorDormantDelay, idleMs, now)
	if (initialized && !suspended) scheduleRender()
}
function resetUserBlink(): void { userPhase = 0 }
function resetHalBlink(): void { hal.phase = 0 }

function splitTitleParts(text: string): { topic: string; session: string } {
	const trimmed = text.trim(); if (!trimmed) return { topic: '', session: '' }
	const idx = trimmed.lastIndexOf(' — ')
	if (idx <= 0) return { topic: '', session: trimmed }
	const topic = trimmed.slice(0, idx).trim(), session = trimmed.slice(idx + 3).trim()
	return topic ? { topic, session } : { topic: '', session: trimmed }
}

function resolveInput(value: string | null): void {
	if (!waitingResolve) return
	const r = waitingResolve
	waitingResolve = null
	r(value)
}

function cols(): number { return process.stdout.columns || 80 }
function rows(): number { return process.stdout.rows || 24 }
function promptContentWidth(): number { return Math.max(1, cols() - inputPromptStr.length - 1) }
function promptLineCount(): number { return Math.max(1, Math.min(wordWrapLines(inputBuf, promptContentWidth()).length, maxPromptLines)) }
function footerHeight(): number { return 4 + promptLineCount() }
function outputBottom(): number { return Math.max(1, rows() - footerHeight()) }
function activityRow(): number { return rows() - footerHeight() + 1 }
function statusRow(): number { return activityRow() + 1 }
function promptTopPadRow(): number { return statusRow() + 1 }
function promptFirstRow(): number { return promptTopPadRow() + 1 }

// ── Low-level terminal writes ──

function directWrite(text: string): void { process.stdout.write(text) }

function isKittyEnv(): boolean { return !!process.env.KITTY_PID || process.env.TERM === 'xterm-kitty' }
function supportsSynchronizedOutput(): boolean {
	return process.stdout.isTTY && (isKittyEnv() || /^(kitty|ghostty)$/.test(process.env.TERM_PROGRAM ?? ''))
}
function supportsKittyKeyboard(): boolean {
	return isKittyEnv() || /^(kitty|ghostty|iTerm\.app)$/.test(process.env.TERM_PROGRAM ?? '')
}
// ── Output storage ──

const CURSOR_UP_ERASE_RE = /\x1b\[(\d+)A\x1b\[J/g

function appendOutput(text: string): void {
	if (!text) return
	// Handle cursor-up + erase-below sequences
	let lastIdx = 0; CURSOR_UP_ERASE_RE.lastIndex = 0
	let m: RegExpExecArray | null
	while ((m = CURSOR_UP_ERASE_RE.exec(text)) !== null) {
		if (m.index > lastIdx) appendRaw(text.slice(lastIdx, m.index))
		const deleteCount = parseInt(m[1], 10)
		if (deleteCount > 0 && outputLines.length > 1) {
			outputLines.length = Math.max(1, outputLines.length - deleteCount)
			outputLines[outputLines.length - 1] = ''
		}
		lastIdx = m.index + m[0].length
	}
	if (lastIdx < text.length) appendRaw(text.slice(lastIdx))
	if (outputLines.length > MAX_OUTPUT_LINES) outputLines = outputLines.slice(-MAX_OUTPUT_LINES)
	lastWrapCols = 0
}

function appendRaw(text: string): void {
	const tw = getConfig().tabWidth
	let i = 0
	while (i < text.length) {
		if (text[i] === '\n') { outputLines.push(''); i++; continue }
		if (text[i] === '\r') { outputLines[outputLines.length - 1] = ''; i++; continue }
		let end = i; while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++
		let chunk = text.slice(i, end)
		if (chunk.includes('\t')) {
			const startCol = stripAnsi(outputLines[outputLines.length - 1]).length
			chunk = expandTabs(chunk, startCol, tw)
		}
		outputLines[outputLines.length - 1] += chunk; i = end
	}
}

// ── Viewport ──

function getTotalVisualLines(): number {
	const c = cols(); if (lastWrapCols === c) return wrappedLineCount
	let total = 0; for (const line of outputLines) total += wrapAnsi(line, c).length
	wrappedLineCount = total; lastWrapCols = c; return total
}

function getVisibleWrapped(outputHeight: number): string[] {
	const c = cols(), need = outputHeight + scrollOffset, allWrapped: string[] = []
	for (let li = outputLines.length - 1; li >= 0; li--) {
		const wrapped = wrapAnsi(linkifyLine(outputLines[li]), c)
		for (let wi = wrapped.length - 1; wi >= 0; wi--) allWrapped.push(wrapped[wi])
		if (allWrapped.length >= need) break
	}
	allWrapped.reverse()
	const end = allWrapped.length - Math.min(scrollOffset, allWrapped.length)
	return allWrapped.slice(Math.max(0, end - outputHeight), end)
}

function scroll(lines: number): void {
	if (!initialized || suspended) return
	const oh = Math.max(0, outputBottom() - 1), maxScroll = Math.max(0, getTotalVisualLines() - oh)
	const prev = scrollOffset
	scrollOffset = Math.max(0, Math.min(maxScroll, scrollOffset + lines))
	const delta = scrollOffset - prev
	if (delta !== 0 && selAnchor?.surface === 'output') {
		selAnchor = { ...selAnchor, row: selAnchor.row + delta }
		if (selCurrent) selCurrent = { ...selCurrent, row: selCurrent.row + delta }
	}
	hoverOutputRow = -1; hoverUrl = null; render()
}

// ── Input selection/edit helpers ──

function clampInputPos(pos: number): number { return Math.max(0, Math.min(pos, inputBuf.length)) }
function clearInputUndoHistory(): void { inputUndoStack = [] }
function clearInputTextSelection(): void { inputSelAnchor = null; inputSelFocus = null; inputSelActive = false }

function getInputTextSelectionRange(): { start: number; end: number } | null {
	if (inputSelAnchor === null || inputSelFocus === null) return null
	const a = clampInputPos(inputSelAnchor), b = clampInputPos(inputSelFocus)
	return a === b ? null : a < b ? { start: a, end: b } : { start: b, end: a }
}

function pushInputUndoSnapshot(): void {
	const prev = inputUndoStack[inputUndoStack.length - 1]
	if (prev && prev.text === inputBuf && prev.cursor === inputCursor &&
		prev.selAnchor === inputSelAnchor && prev.selFocus === inputSelFocus) return
	inputUndoStack.push({ text: inputBuf, cursor: inputCursor, selAnchor: inputSelAnchor, selFocus: inputSelFocus })
	if (inputUndoStack.length > 200) inputUndoStack.splice(0, inputUndoStack.length - 200)
}

function undoInputEdit(): boolean {
	const snap = inputUndoStack.pop(); if (!snap) return false
	inputBuf = snap.text; inputCursor = clampInputPos(snap.cursor)
	inputSelAnchor = snap.selAnchor === null ? null : clampInputPos(snap.selAnchor)
	inputSelFocus = snap.selFocus === null ? null : clampInputPos(snap.selFocus)
	inputSelActive = false; return true
}
function setInputCursor(pos: number, extendSelection = false): void {
	const next = clampInputPos(pos)
	if (extendSelection) { if (inputSelAnchor === null) inputSelAnchor = inputCursor; inputSelFocus = next }
	else clearInputTextSelection()
	inputCursor = next
}

function replaceInputRange(start: number, end: number, text: string): void {
	pushInputUndoSnapshot()
	const a = clampInputPos(start), b = clampInputPos(end), lo = Math.min(a, b), hi = Math.max(a, b)
	inputBuf = inputBuf.slice(0, lo) + text + inputBuf.slice(hi)
	inputCursor = lo + text.length; clearInputTextSelection()
}

function deleteInputTextSelection(): boolean {
	const sel = getInputTextSelectionRange(); if (!sel) return false
	replaceInputRange(sel.start, sel.end, ''); return true
}

function insertIntoInput(text: string): void {
	const sel = getInputTextSelectionRange()
	if (sel) { replaceInputRange(sel.start, sel.end, text); return }
	pushInputUndoSnapshot()
	inputBuf = inputBuf.slice(0, inputCursor) + text + inputBuf.slice(inputCursor); inputCursor += text.length
}

function collapseInputSelection(edge: 'start' | 'end'): boolean {
	const sel = getInputTextSelectionRange(); if (!sel) return false
	inputCursor = edge === 'start' ? sel.start : sel.end; clearInputTextSelection(); return true
}

function lineBoundaryLeft(buf: string, cursor: number): number { return buf.lastIndexOf('\n', Math.max(0, cursor) - 1) + 1 }
function lineBoundaryRight(buf: string, cursor: number): number { const i = buf.indexOf('\n', Math.max(0, cursor)); return i >= 0 ? i : buf.length }

function inputWordRangeAt(pos: number): { start: number; end: number } {
	const clamped = clampInputPos(pos)
	if (inputBuf.length === 0) return { start: 0, end: 0 }
	if (clamped < inputBuf.length && /\s/.test(inputBuf[clamped])) {
		let start = clamped, end = clamped
		while (start > 0 && /\s/.test(inputBuf[start - 1])) start--
		while (end < inputBuf.length && /\s/.test(inputBuf[end])) end++
		return { start, end }
	}
	return { start: wordBoundaryLeft(inputBuf, clamped), end: wordBoundaryRight(inputBuf, clamped) }
}

function inputLineRangeAt(pos: number): { start: number; end: number } {
	const c = clampInputPos(pos)
	return { start: lineBoundaryLeft(inputBuf, c), end: lineBoundaryRight(inputBuf, c) }
}

function writeClipboardText(text: string): void {
	if (!text) return
	try { const p = Bun.spawn(['pbcopy'], { stdin: 'pipe' }); p.stdin.write(text); p.stdin.end() } catch {}
}

function clipInputSel(cut: boolean): boolean {
	const sel = getInputTextSelectionRange(); if (!sel) return false
	writeClipboardText(inputBuf.slice(sel.start, sel.end))
	if (cut) replaceInputRange(sel.start, sel.end, ''); return true
}

function copyToClipboard(): boolean {
	if (clipInputSel(false)) return true
	const sel = getSelectionRange(); if (!sel) return false
	const text = screenSelectionText(sel); if (!text) return false
	writeClipboardText(text); return true
}

function cutCurrentInputLineToClipboard(): boolean {
	const start = inputBuf.lastIndexOf('\n', Math.max(0, inputCursor - 1)) + 1
	const next = inputBuf.indexOf('\n', inputCursor)
	const end = next === -1 ? inputBuf.length : next + 1
	if (start >= end) return false
	writeClipboardText(inputBuf.slice(start, end)); replaceInputRange(start, end, ''); return true
}

function cleanAndInsertPaste(text: string): void {
	const clean = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '')
	if (clean) { insertIntoInput(clean.includes('\n') ? saveMultilinePaste(clean) : clean); render() }
}

function pasteClipboardIntoInput(): void { pasteFromClipboard().then((c) => { if (c) cleanAndInsertPaste(c) }) }

function setInputTextWithUndo(text: string, cursor = text.length): void {
	if (text === inputBuf && cursor === inputCursor) return
	pushInputUndoSnapshot(); inputBuf = text; inputCursor = clampInputPos(cursor); clearInputTextSelection()
}

function handleInputClipboardShortcutKey(key: string): boolean {
	const modOther = key.match(/^\x1b\[27;(\d+);(\d+)~$/)
	const csiU = parseKittyCsiUKey(key)
	if (csiU && csiU.eventType !== 1) return true
	const modifier = Number(modOther?.[1] ?? csiU?.rawModifier ?? NaN)
	const codepoint = Number(modOther?.[2] ?? csiU?.codepoint ?? NaN)
	if (!Number.isFinite(modifier) || !Number.isFinite(codepoint) || modifier < 9) return false
	const ch = String.fromCharCode(codepoint).toLowerCase()
	if (ch === 'c') { if (copyToClipboard()) render(); return true }
	if (ch === 'x') { if (clipInputSel(true) || cutCurrentInputLineToClipboard()) render(); return true }
	if (ch === 'v') { pasteClipboardIntoInput(); return true }
	if (ch === 'a') {
		inputSelAnchor = 0; inputSelFocus = inputBuf.length
		inputCursor = inputBuf.length; inputSelActive = false; render(); return true
	}
	if (ch === 'z' || ch === 'u') { if (undoInputEdit()) render(); return true }
	return false
}

function inputPosFromWrappedPoint(row: number, col: number): number { return wrappedRowColToCursor(inputBuf, row, Math.max(0, col), promptContentWidth()) }

function inputWrappedPointFromScreen(x: number, y: number): { row: number; col: number } | null {
	const { lines } = getWrappedInputLayout(inputBuf, promptContentWidth())
	const row = y - (promptFirstRow() - 1)
	if (row < 0 || row >= Math.min(lines.length, maxPromptLines)) return null
	return { row, col: Math.max(0, x - inputPromptStr.length) }
}

function renderPromptLineWithCursor(
	lineText: string, lineStart: number, screenCols: number,
	inputSel: { start: number; end: number } | null, cursorCol: number, cursorT: number,
): string {
	const pad = ' '.repeat(Math.max(0, screenCols - inputPromptStr.length - lineText.length))
	if (inputSel) {
		const selStart = Math.max(0, Math.min(lineText.length, inputSel.start - lineStart))
		const selEnd = Math.max(0, Math.min(lineText.length, inputSel.end - lineStart))
		if (selStart < selEnd)
			return `${BG_DARK}${inputPromptStr}${lineText.slice(0, selStart)}\x1b[7m${lineText.slice(selStart, selEnd)}\x1b[27m${lineText.slice(selEnd)}${pad}${RESET}`
	}
	if (cursorCol < 0) return `${BG_DARK}${inputPromptStr}${lineText}${pad}${RESET}`
	const uc = windowFocused
		? `${lerpCh(102, cursorT, 48)};${lerpCh(187, cursorT, 48)};${lerpCh(255, cursorT, 48)}`
		: `${lerpCh(100, cursorT, 48)};${lerpCh(100, cursorT, 48)};${lerpCh(100, cursorT, 48)}`
	if (cursorCol >= lineText.length) {
		return `${BG_DARK}${inputPromptStr}${lineText.slice(0, cursorCol)}\x1b[48;2;${uc}m ${RESET}${BG_DARK}${pad}${RESET}`
	}
	// Mid-line: hardware bar cursor will be positioned here
	return `${BG_DARK}${inputPromptStr}${lineText}${pad}${RESET}`
}
// ── Mouse selection ──

function screenSelectionLine(surface: SelectionSurface, row: number): string {
	if (surface === 'output') return lastVisibleOutput[row] ?? ''
	if (surface === 'input') return inputBuf
	if (row !== 0) return ''
	return { title: lastTitleLine, activity: lastActivityLine, status: lastStatusLine }[surface] ?? ''
}

function screenSelectionText(sel: SelectionRange): string {
	const lines: string[] = []
	for (let row = sel.startRow; row <= sel.endRow; row++) {
		const plain = stripAnsi(screenSelectionLine(sel.surface, row))
		lines.push(plain.slice(row === sel.startRow ? sel.startCol : 0, row === sel.endRow ? sel.endCol : plain.length))
	}
	return lines.join('\n')
}

function getSelectionRange(): SelectionRange | null {
	if (!selAnchor || !selCurrent || selAnchor.surface !== selCurrent.surface) return null
	let a = selAnchor, b = selCurrent
	if (selMode === 'word') { a = expandToWordBoundary(a, 'start'); b = expandToWordBoundary(b, 'end') }
	else if (selMode === 'line') { a = { ...a, col: 0 }; b = { ...b, col: cols() } }
	if (a.row > b.row || (a.row === b.row && a.col > b.col)) {
		if (selMode === 'word') { a = expandToWordBoundary(selCurrent, 'start'); b = expandToWordBoundary(selAnchor, 'end') }
		else [a, b] = [b, a]
	}
	return { surface: a.surface, startRow: a.row, startCol: a.col, endRow: b.row, endCol: b.col }
}

function selectionLine(pt: SelectionPoint): string {
	if (pt.surface === 'input') return getWrappedInputLayout(inputBuf, promptContentWidth()).lines[pt.row] ?? ''
	return screenSelectionLine(pt.surface, pt.row)
}

function expandToWordBoundary(pt: SelectionPoint, side: 'start' | 'end'): SelectionPoint {
	const plain = stripAnsi(selectionLine(pt))
	const col = Math.min(pt.col, plain.length)
	if (side === 'start') {
		let i = Math.min(col, plain.length - 1)
		if (i < 0) return { ...pt, col: 0 }
		while (i > 0 && /\W/.test(plain[i])) i--
		while (i > 0 && /\w/.test(plain[i - 1])) i--
		return { ...pt, col: i }
	}
	let i = col
	while (i < plain.length && /\W/.test(plain[i])) i++
	while (i < plain.length && /\w/.test(plain[i])) i++
	return { ...pt, col: i }
}

function renderLineWithSelection(line: string, row: number, sel: SelectionRange): string {
	const plain = stripAnsi(line), c = cols(), truncated = plain.slice(0, c)
	let selStart = 0, selEnd = truncated.length
	if (row === sel.startRow) selStart = Math.max(0, sel.startCol)
	if (row === sel.endRow) selEnd = Math.min(truncated.length, sel.endCol)
	if (selStart >= selEnd) return truncateAnsi(line, c)

	const result: string[] = []
	let visCol = 0, inSel = false, i = 0
	while (i < line.length && visCol < c) {
		if (line[i] === '\x1b') {
			const seqLen = readEscapeSequence(line, i)
			const seq = line.slice(i, i + seqLen)
			result.push(seq)
			// Re-apply inverse after embedded SGR resets
			if (inSel && seq.startsWith('\x1b[') && seq.endsWith('m')) result.push('\x1b[7m')
			i += seqLen; continue
		}
		if (visCol === selStart && !inSel) { result.push('\x1b[7m'); inSel = true }
		if (visCol === selEnd && inSel) { result.push('\x1b[27m'); inSel = false }
		result.push(line[i]); visCol++; i++
	}
	if (inSel) result.push('\x1b[27m')
	result.push(RESET)
	return result.join('')
}

function pointFromScreenCoords(x: number, y: number): SelectionPoint | null {
	const inputPt = inputWrappedPointFromScreen(x, y)
	if (inputPt) return { surface: 'input', row: inputPt.row, col: inputPt.col }
	if (y === 0) return { surface: 'title', row: 0, col: x }
	const outputRow = y - 1
	if (outputRow >= 0 && outputRow < Math.max(0, outputBottom() - 1)) return { surface: 'output', row: outputRow, col: x }
	if (y === activityRow() - 1) return { surface: 'activity', row: 0, col: x }
	if (y === statusRow() - 1) return { surface: 'status', row: 0, col: x }
	return null
}

function updateHoverLink(): void {
	let newRow = -1, newUrl: string | null = null
	if (superHeld && lastMouseX >= 0) {
		const pt = pointFromScreenCoords(lastMouseX, lastMouseY)
		if (pt?.surface === 'output') {
			newUrl = urlAtCol(lastVisibleOutput[pt.row] ?? '', pt.col)
			if (newUrl) newRow = pt.row
		}
	}
	if (newRow !== hoverOutputRow || newUrl !== hoverUrl) {
		hoverOutputRow = newRow; hoverUrl = newUrl
		render()
	}
}

function updateInputSelFocus(pos: number): void {
	const range = selMode === 'word' ? inputWordRangeAt(pos)
		: selMode === 'line' ? inputLineRangeAt(pos) : null
	if (range) {
		inputSelFocus = inputSelAnchor !== null && range.start < inputSelAnchor ? range.start : range.end
	} else {
		inputSelFocus = pos
	}
	inputCursor = inputSelFocus
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
		const samePos = lastClickPos && lastClickPos.surface === pt.surface &&
			lastClickPos.row === pt.row && Math.abs(lastClickPos.col - x) <= 1
		clickCount = (samePos && now - lastClickTime < 400) ? Math.min(clickCount + 1, 3) : 1
		lastClickTime = now
		lastClickPos = pt
		selMode = clickCount === 1 ? 'char' : clickCount === 2 ? 'word' : 'line'

		if (pt.surface === 'input') {
			if (selAnchor) clearSelection(false)
			const pos = inputPosFromWrappedPoint(pt.row, pt.col)
			if (clickCount >= 2) {
				const range = clickCount === 2 ? inputWordRangeAt(pos) : inputLineRangeAt(pos)
				inputSelAnchor = range.start; inputSelFocus = range.end; inputCursor = range.end
			} else {
				inputSelAnchor = pos; inputSelFocus = pos; inputCursor = pos
			}
			inputSelActive = true; render(); return
		}

		clearInputTextSelection()
		selAnchor = pt; selCurrent = pt; selActive = true; render(); return
	}

	if (kind === 'move' && selActive) {
		const pt = pointFromScreenCoords(x, y)
		if (!pt || !selAnchor || pt.surface !== selAnchor.surface) return
		selCurrent = pt; render(); return
	}

	if (kind === 'move' && inputSelActive) {
		const pt = pointFromScreenCoords(x, y)
		if (!pt || pt.surface !== 'input') return
		updateInputSelFocus(inputPosFromWrappedPoint(pt.row, pt.col))
		render(); return
	}

	// Cmd+hover detection for link underline
	if (kind === 'move' && !selActive && !inputSelActive) {
		lastMouseX = x; lastMouseY = y; updateHoverLink(); return
	}

	if (kind === 'release' && selActive) {
		const pt = pointFromScreenCoords(x, y)
		if (pt && selAnchor && pt.surface === selAnchor.surface) selCurrent = pt
		selActive = false
		// Single click (no drag) on output — check for URL
		if (clickCount === 1 && pt && selAnchor &&
			pt.surface === 'output' && pt.row === selAnchor.row && pt.col === selAnchor.col) {
			const url = urlAtCol(lastVisibleOutput[pt.row] ?? '', pt.col)
			if (url) {
				selAnchor = null; selCurrent = null; render()
				const normalized = normalizeDetectedUrl(url)
				if (normalized) Bun.spawn(['open', normalized])
				return
			}
		}
		render(); return
	}

	if (kind === 'release' && inputSelActive) {
		const pt = pointFromScreenCoords(x, y)
		if (pt && pt.surface === 'input') updateInputSelFocus(inputPosFromWrappedPoint(pt.row, pt.col))
		inputSelActive = false; render()
	}
}
function clearSelection(renderNow = true): void {
	if (!selAnchor) return
	selAnchor = null
	selCurrent = null
	selActive = false
	if (renderNow) render()
}

function enableMouse(): void {
	if (supportsKittyKeyboard()) directWrite(KITTY_KEYBOARD_ENABLE)
	directWrite('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h')
}
function disableMouse(): void {
	if (supportsKittyKeyboard()) directWrite(KITTY_KEYBOARD_DISABLE)
	directWrite('\x1b[?1004l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l')
}

// ── Render ──

let renderScheduled = false
let lastRenderedOutputHeight = 0, lastRenderedTotalVisual = 0

function scheduleRender(): void {
	if (renderScheduled) return; renderScheduled = true; queueMicrotask(render)
}

function render(): void {
	renderScheduled = false
	if (!initialized || ended || suspended) return
	const r = rows(), c = cols(), fh = footerHeight()
	const ob = Math.max(1, r - fh), outputHeight = Math.max(0, ob - 1)

	if (scrollOffset > 0) {
		const maxScroll = Math.max(0, getTotalVisualLines() - outputHeight)
		if (scrollOffset > maxScroll) scrollOffset = maxScroll
	}
	const visibleOutput = getVisibleWrapped(outputHeight)
	lastVisibleOutput = visibleOutput
	lastRenderedOutputHeight = outputHeight; lastRenderedTotalVisual = getTotalVisualLines()
	const selRange = getSelectionRange()
	const chunks: string[] = ['\x1b[?25l']

	const pushRow = (row: number, text: string, surface?: SelectionSurface, selRow = 0) => {
		chunks.push(`\x1b[${row};1H\x1b[2K`)
		if (selRange && selRange.surface === surface && selRow >= selRange.startRow && selRow <= selRange.endRow)
			chunks.push(renderLineWithSelection(text, selRow, selRange))
		else chunks.push(text)
	}

	// Title bar
	const { topic, session } = splitTitleParts(titleBarStr || '')
	const PLACEHOLDER = 'Use /topic to set topic, or write a prompt to set it automatically'
	const topicDisplay = topic
		? `${TITLE_BG}${TITLE_TOPIC} Topic: ${TITLE_SESSION}${topic}`
		: `${TITLE_BG}${TITLE_TOPIC} Topic: ${TITLE_TOPIC}${PLACEHOLDER}`
	const titleLine = session ? `${topicDisplay}${RESET}${TITLE_BG}${TITLE_TOPIC} — ${session}` : topicDisplay
	pushRow(1, truncateAnsi(titleLine, c) + TITLE_BG + ERASE_TO_EOL + RESET, 'title')
	const plainTopic = topic || PLACEHOLDER
	lastTitleLine = truncateAnsi(session ? ` Topic: ${plainTopic} — ${session}` : ` Topic: ${plainTopic}`, c).padEnd(c, ' ')

	// Output viewport
	const halCursorIdx = scrollOffset === 0 ? visibleOutput.length - 1 : -1
	for (let row = 2; row <= ob; row++) {
		const idx = row - 2
		let lineText = visibleOutput[idx] ?? ''
		if (idx === halCursorIdx) {
			const ht = brightness(hal.phase) * halIntensity
			const [cr, cg, cb] = cursorRGB()
			const cursor = `\x1b[38;2;${lerpCh(cr, ht)};${lerpCh(cg, ht)};${lerpCh(cb, ht)}m${shrinkChar(hal)}${RESET}`
			lineText = truncateAnsi(lineText, c - 1) + cursor
		}
		if (hoverUrl && idx === hoverOutputRow) lineText = underlineOsc8Link(lineText, hoverUrl)
		if (selRange?.surface === 'output' && idx >= selRange.startRow && idx <= selRange.endRow)
			pushRow(row, lineText, 'output', idx)
		else { chunks.push(`\x1b[${row};1H\x1b[2K`); chunks.push(truncateAnsi(lineText, c)) }
	}

	// Activity + status
	lastActivityLine = truncateAnsi(`${DIM}${activityStr ? `  Model: ${activityStr}` : '  Model: Done.'}`, c)
	pushRow(activityRow(), lastActivityLine, 'activity')
	lastStatusLine = buildStatusBarLine(cols(), statusTabsStr, headerFlash || statusRightStr, scrollOffset)
	pushRow(statusRow(), lastStatusLine, 'status')

	// Prompt area
	const bgPad = `${BG_DARK}${' '.repeat(c)}${RESET}`
	chunks.push(`\x1b[${promptTopPadRow()};1H\x1b[2K${bgPad}`)
	const contentWidth = promptContentWidth()
	const wrappedInput = getWrappedInputLayout(inputBuf, contentWidth)
	const inputSelRange = getInputTextSelectionRange()
	const pLines = Math.min(wrappedInput.lines.length, maxPromptLines), firstRow = promptFirstRow()
	const { row: curRow, col: curCol } = cursorToWrappedRowCol(inputBuf, inputCursor, contentWidth)
	const ut = brightness(userPhase)
	for (let i = 0; i < pLines; i++) {
		chunks.push(`\x1b[${firstRow + i};1H\x1b[2K`)
		const onCursorRow = userCursorMode === 'block' && i === curRow
		chunks.push(renderPromptLineWithCursor(wrappedInput.lines[i], wrappedInput.starts[i] ?? 0, c, inputSelRange, onCursorRow ? curCol : -1, ut))
	}
	chunks.push(`\x1b[${r};1H\x1b[2K${bgPad}`)

	// Hardware cursor: native mode always, block mode for mid-line bar
	const curLineLen = wrappedInput.lines[curRow]?.length ?? 0
	if (userCursorMode === 'native' || (userCursorMode === 'block' && curCol < curLineLen)) {
		const style = userCursorMode === 'native' ? '\x1b[0 q' : '\x1b[5 q' // default or blinking bar
		const cursorOsc = windowFocused ? CURSOR_BLUE_OSC : CURSOR_GREY_OSC
		chunks.push(`${cursorOsc}${style}\x1b[${firstRow + curRow};${curCol + 1 + inputPromptStr.length}H\x1b[?25h`)
	}

	const frame = chunks.join('')
	if (supportsSynchronizedOutput()) directWrite(`\x1b[?2026h${frame}\x1b[?2026l`)
	else directWrite(frame)
}

// ── Suspend/resume ──

function dumpAndLeaveAltScreen(): void {
	const c = cols(), visible = getVisibleWrapped(Math.max(0, outputBottom() - 1))
	disableMouse(); directWrite(CURSOR_RESET + '\x1b[?25h') // reset cursor style + show
	directWrite('\x1b[?1049l') // leave alt screen
	if (process.stdin.isTTY) process.stdin.setRawMode(false)
	directWrite(`\x1b[${rows()};1H\r\n`)
	for (const line of visible) directWrite(truncateAnsi(line, c) + '\r\n')
}

function suspendForegroundJob(): void {
	suspended = true; dumpAndLeaveAltScreen()
	try { process.kill(0, 'SIGSTOP') } catch { process.kill(process.pid, 'SIGSTOP') }
}

function handleBracketedPaste(text: string): void {
	if (waitingResolve) cleanAndInsertPaste(text)
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
	let rawModifier = 1, eventType = 1
	if (fields.length >= 2) {
		const [rawModifierStr, eventTypeStr] = (fields[1] ?? '').split(':', 2)
		if (rawModifierStr) rawModifier = Number(rawModifierStr)
		if (eventTypeStr) eventType = Number(eventTypeStr)
	}
	if (!Number.isFinite(codepoint) || !Number.isFinite(rawModifier) || !Number.isFinite(eventType)) return null
	let text: string | undefined
	if (fields.length >= 3 && fields[2]) {
		const cps = fields[2].split(':').map(Number)
		if (cps.length > 0 && cps.every((n) => Number.isFinite(n) && n > 0)) text = String.fromCodePoint(...cps)
	}
	return { codepoint, rawModifier, eventType, text }
}

function normalizeKittyFunctionalKey(key: string): string | null | undefined {
	if (!key.startsWith('\x1b[')) return undefined
	const terminator = key[key.length - 1]
	if (!/^[~A-DHFP-S]$/.test(terminator)) return undefined
	const body = key.slice(2, -1)
	if (!body.includes(':')) return undefined
	const fields = body.split(';')
	let eventType = 1
	const lastField = fields[fields.length - 1], colonIdx = lastField.indexOf(':')
	if (colonIdx !== -1) {
		eventType = Number(lastField.slice(colonIdx + 1))
		fields[fields.length - 1] = lastField.slice(0, colonIdx)
	}
	if (eventType === 3) return null
	while (fields.length > 1 && fields[fields.length - 1] === '1') fields.pop()
	if (fields.length === 1 && fields[0] === '1' && terminator !== '~') fields[0] = ''
	return `\x1b[${fields.join(';')}${terminator}`
}

function normalizeKittyKey(key: string): string | null {
	if (key.length === 4 && key[0] === '\x1b' && key[1] === '\x1b' && key[2] === '[') {
		const arrow = key[3]; if (arrow >= 'A' && arrow <= 'D') return `\x1b[1;3${arrow}`
	}
	const csiU = parseKittyCsiUKey(key)
	if (!csiU) { const f = normalizeKittyFunctionalKey(key); return f !== undefined ? f : key }
	const { codepoint, rawModifier, eventType, text } = csiU

	if (codepoint === SUPER_L || codepoint === SUPER_R) {
		const wasHeld = superHeld; superHeld = eventType !== 3
		if (wasHeld !== superHeld) updateHoverLink(); return null
	}
	if (eventType === 3) return null
	if (codepoint >= 0xE000 && codepoint <= 0xF8FF) return null

	const mods = Math.max(0, rawModifier - 1)
	if ((mods & 8) !== 0) return key
	if ((mods & 4) !== 0 && codepoint >= 0 && codepoint <= 0x7f) {
		const ctrl = String.fromCharCode(codepoint & 0x1f)
		return (mods & 2) !== 0 ? `\x1b${ctrl}` : ctrl
	}
	if ((mods & 2) !== 0 && !(mods & 4) && codepoint >= 0x20 && codepoint <= 0x7f)
		return `\x1b${String.fromCharCode(codepoint)}`
	if (mods === 0) {
		if (codepoint === 13) return '\r'; if (codepoint === 9) return '\t'
		if (codepoint === 27) return '\x1b'; if (codepoint === 127) return '\x7f'
	}
	if (mods === 1) { if (codepoint === 27) return '\x1b'; if (codepoint === 127) return '\x7f' }
	if ((mods === 0 || mods === 1) && (text || codepoint >= 0x20)) return text ?? String.fromCodePoint(codepoint)
	return key
}

export const _testCursor = {
	get hal() { return hal },
	isDormant(): boolean { return isDormant(hal) },
	resetAll(): void {
		tabCursors.clear(); activeTabCursorId = ''
		resetShrink(hal); hal.phase = 0; hal.period = 1000; halIntensity = 0.5
	},
}
export const _testTuiKeys = {
	parseKittyCsiUKey, normalizeKittyFunctionalKey, normalizeKittyKey, supportsSynchronizedOutput,
	resetState(): void {
		hoverOutputRow = -1; hoverUrl = null; superHeld = false; lastMouseX = -1; lastMouseY = -1
	},
}

// ── Key action helpers ──

function moveCursor(pos: number, extend = false): void { setInputCursor(pos, extend); render() }
function moveOrCollapse(edge: 'start' | 'end', pos: number): void { if (!collapseInputSelection(edge)) setInputCursor(pos); render() }
function deleteOrSel(fallback: () => void): void { if (!deleteInputTextSelection()) fallback(); render() }

// ── Key handler ──

function handleKey(key: string): void {
	const normalizedKitty = normalizeKittyKey(key)
	if (normalizedKitty === null) return
	key = normalizedKitty
	resetUserBlink()
	const prevGoalCol = inputGoalCol
	inputGoalCol = null
	if (inputKeyHandler && inputKeyHandler(key)) return

	// Clipboard shortcuts — handle before clearing output selection
	if (handleInputClipboardShortcutKey(key)) return
	if (key === '\x1bw') { if (copyToClipboard()) render(); return }

	// Any real keypress clears output selection
	if (selAnchor) clearSelection()

	if (key === CTRL_C) {
		if (waitingResolve) resolveInput(CTRL_C)
		else { cleanup(); process.exit(100) }
		return
	}
	if (key === CTRL_D) {
		if (inputBuf.length === 0) resolveInput(null)
		else return deleteOrSel(() => {
			if (inputCursor < inputBuf.length) replaceInputRange(inputCursor, inputCursor + 1, '')
		})
		return
	}
	if (key === CTRL_Z) return suspendForegroundJob()
	if (key === '\x1bz') { if (undoInputEdit()) render(); return }
	if (key === CTRL_X) { if (clipInputSel(true)) render(); return }
	if (key === CTRL_Y || key === CTRL_V) return pasteClipboardIntoInput()
	if (key === '\x1ba' || key === '\x1bA') {
		inputSelAnchor = 0; inputSelFocus = inputBuf.length
		inputCursor = inputBuf.length; inputSelActive = false
		render(); return
	}

	// Shift+Enter / Option+Enter: insert newline
	if (key === '\x1b\r' || key === '\x1b\n' || key === '\x1b[13;2u' || key === '\x1b[27;2;13~') {
		insertIntoInput('\n'); render(); return
	}

	// Enter / Return
	if (key === '\r' || key === '\n') {
		const value = inputBuf
		const now = Date.now()
		if (!value.trim() && lastSubmitTime > 0 && now - lastSubmitTime < 1000) {
			lastSubmitTime = 0
			if (doubleEnterHandler) doubleEnterHandler()
			return
		}
		if (value.trim()) { inputHistory.push(value); lastSubmitTime = now }
		historyIndex = -1; historyDraft = ''
		inputBuf = ''; inputCursor = 0
		clearInputTextSelection(); clearInputUndoHistory()
		render()
		resolveInput(value)
		return
	}

	// Delete keys (selection takes precedence)
	if (key === '\x1b\x7f') return deleteOrSel(() => {
		if (inputCursor > 0) replaceInputRange(wordBoundaryLeft(inputBuf, inputCursor), inputCursor, '')
	})
	if (key === '\x7f' || key === '\b') return deleteOrSel(() => {
		if (inputCursor > 0) replaceInputRange(inputCursor - 1, inputCursor, '')
	})
	if (key === '\x1b[3~') return deleteOrSel(() => {
		if (inputCursor < inputBuf.length) replaceInputRange(inputCursor, inputCursor + 1, '')
	})
	if (key === CTRL_U) return deleteOrSel(() => replaceInputRange(0, inputCursor, ''))
	if (key === CTRL_K) return deleteOrSel(() => replaceInputRange(inputCursor, inputBuf.length, ''))

	// Shift+Arrow: extend selection
	if (key === '\x1b[1;2D') return moveCursor(inputCursor - 1, true)
	if (key === '\x1b[1;2C') return moveCursor(inputCursor + 1, true)
	if (key === '\x1b[1;4D') return moveCursor(wordBoundaryLeft(inputBuf, inputCursor), true)
	if (key === '\x1b[1;4C') return moveCursor(wordBoundaryRight(inputBuf, inputCursor), true)

	// Arrow keys with selection collapse
	if (key === '\x1b[D' || key === '\x1bOD') return moveOrCollapse('start', inputCursor - 1)
	if (key === '\x1b[C' || key === '\x1bOC') return moveOrCollapse('end', inputCursor + 1)
	if (key === '\x1b[1;3D' || key === '\x1bb') return moveOrCollapse('start', wordBoundaryLeft(inputBuf, inputCursor))
	if (key === '\x1b[1;3C' || key === '\x1bf') return moveOrCollapse('end', wordBoundaryRight(inputBuf, inputCursor))

	// Shift+Home/End, Shift+Cmd+Left/Right
	if (key === '\x1b[1;2H' || key === '\x1b[1;10D') return moveCursor(0, true)
	if (key === '\x1b[1;2F' || key === '\x1b[1;10C') return moveCursor(inputBuf.length, true)

	// Home / Ctrl-A / Cmd+Left
	if (key === '\x1b[H' || key === '\x1bOH' || key === '\x01' || key === '\x1b[1;9D') return moveCursor(0)
	// End / Ctrl-E / Cmd+Right
	if (key === '\x1b[F' || key === '\x1bOF' || key === '\x05' || key === '\x1b[1;9C') return moveCursor(inputBuf.length)

	// Arrow Up/Down with vertical move + history
	if (key === '\x1b[A' || key === '\x1bOA' || key === '\x1b[B' || key === '\x1bOB') {
		const dir = (key === '\x1b[A' || key === '\x1bOA') ? -1 : 1
		clearInputTextSelection()
		const r = verticalMove(inputBuf, promptContentWidth(), inputCursor, prevGoalCol, dir)
		if (!r.atBoundary) {
			inputCursor = r.cursor; inputGoalCol = r.goalCol; render(); return
		}
		if (dir === -1) {
			if (inputHistory.length === 0) return
			if (historyIndex < 0) { historyDraft = inputBuf; historyIndex = inputHistory.length - 1 }
			else if (historyIndex > 0) historyIndex--
			else return
			setInputTextWithUndo(inputHistory[historyIndex])
		} else {
			if (historyIndex < 0) return
			if (historyIndex < inputHistory.length - 1) {
				historyIndex++; setInputTextWithUndo(inputHistory[historyIndex])
			} else {
				historyIndex = -1; setInputTextWithUndo(historyDraft); historyDraft = ''
			}
		}
		render(); return
	}

	// PageUp / PageDown / Option+P / Option+N
	if (key === '\x1b[5~' || key === '\x1bp') return scroll(Math.max(1, rows() - 3))
	if (key === '\x1b[6~' || key === '\x1bn') return scroll(-Math.max(1, rows() - 3))

	// Option+Up/Down: jump to start/end
	if (key === '\x1b[1;3A') return moveCursor(0)
	if (key === '\x1b[1;3B') return moveCursor(inputBuf.length)

	// Shift+Up/Down: extend selection vertically
	if (key === '\x1b[1;2A' || key === '\x1b[1;2B') {
		const dir = key === '\x1b[1;2A' ? -1 : 1
		const r = verticalMove(inputBuf, promptContentWidth(), inputCursor, prevGoalCol, dir)
		const pos = r.atBoundary ? (dir === -1 ? 0 : inputBuf.length) : r.cursor
		setInputCursor(pos, true); inputGoalCol = r.goalCol; render()
		return
	}

	// Shift+Option+Up/Down: extend selection to start/end
	if (key === '\x1b[1;4A') return moveCursor(0, true)
	if (key === '\x1b[1;4B') return moveCursor(inputBuf.length, true)

	// Tab completion
	if (key === '\t') {
		if (tabCompleter) {
			const matches = tabCompleter(inputBuf)
			if (matches.length === 1) {
				setInputTextWithUndo(matches[0]); render()
			} else if (matches.length > 1) {
				let common = matches[0]
				for (let i = 1; i < matches.length; i++) {
					while (common.length > 0 && !matches[i].startsWith(common)) common = common.slice(0, -1)
				}
				if (common.length > inputBuf.length) setInputTextWithUndo(common)
				writeToOutput(`\x1b[2m${matches.join('  ')}\x1b[0m\n`); render()
			}
		}
		return
	}

	// Esc
	if (key === '\x1b') { if (escHandler) escHandler(); return }

	// Ignore other control characters
	if (key.length === 1 && key.charCodeAt(0) < 0x20) return

	// xterm modifyOtherKeys
	const modifyOtherKeys = key.match(/^\x1b\[27;\d+;(\d+)~$/)
	if (modifyOtherKeys) {
		const ch = String.fromCharCode(Number(modifyOtherKeys[1]))
		if (ch) { insertIntoInput(ch); render() }
		return
	}

	// Skip unknown escape sequences
	if (key.startsWith('\x1b')) return

	// Multi-character paste or printable input
	if (key.length > 1 && key.includes('\n')) insertIntoInput(saveMultilinePaste(key))
	else {
		const clean = key.replace(/[\x00-\x1f]/g, '')
		if (!clean) return
		insertIntoInput(clean)
	}
	render()
}

// ── Stdin processing ──

function flushStdinBuffer(): void {
	const data = stdinBuffer; stdinBuffer = ''; stdinTimer = null
	logKeypress(data)
	for (const key of parseKeys(data, PASTE_START, PASTE_END)) handleKey(key)
}

const onStdinData = (chunk: Buffer | string) => {
	const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
	if (!text) return

	if (bracketedPasteBuffer !== null) {
		const endIdx = text.indexOf(PASTE_END)
		if (endIdx >= 0) {
			bracketedPasteBuffer += text.slice(0, endIdx)
			handleBracketedPaste(bracketedPasteBuffer); bracketedPasteBuffer = null
			const rest = text.slice(endIdx + PASTE_END.length); if (rest) onStdinData(rest)
		} else bracketedPasteBuffer += text
		return
	}
	if (text.includes(PASTE_START)) {
		const startIdx = text.indexOf(PASTE_START) + PASTE_START.length
		const endIdx = text.indexOf(PASTE_END, startIdx)
		if (endIdx >= 0) {
			handleBracketedPaste(text.slice(startIdx, endIdx))
			const rest = text.slice(endIdx + PASTE_END.length); if (rest) onStdinData(rest)
		} else bracketedPasteBuffer = text.slice(startIdx)
		return
	}

	// Focus reporting
	if (text === '\x1b[I') { windowFocused = true; scheduleRender(); return }
	if (text === '\x1b[O') { windowFocused = false; scheduleRender(); return }
	const mouseRe = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
	let mouseMatch = mouseRe.exec(text)
	if (mouseMatch) {
		let scrollDelta = 0
		do {
			const button = parseInt(mouseMatch[1], 10)
			const x = parseInt(mouseMatch[2], 10), y = parseInt(mouseMatch[3], 10)
			const isRelease = mouseMatch[4] === 'm', baseButton = button & ~32
			if (baseButton === 64) scrollDelta++
			else if (baseButton === 65) scrollDelta--
			else if (baseButton === 0) handleMouseEvent(x - 1, y - 1, isRelease ? 'release' : (button & 32) ? 'move' : 'press')
			else if (baseButton === 3 && (button & 32)) handleMouseEvent(x - 1, y - 1, 'move')
			mouseMatch = mouseRe.exec(text)
		} while (mouseMatch)
		if (scrollDelta !== 0) scroll(scrollDelta)
		return
	}

	stdinBuffer += text
	if (stdinTimer) clearTimeout(stdinTimer)
	if (stdinBuffer.includes(PASTE_START) && !stdinBuffer.includes(PASTE_END))
		stdinTimer = setTimeout(flushStdinBuffer, STDIN_COALESCE_MS)
	else flushStdinBuffer()
}

const onStdinEnd = () => { if (!suspended) { ended = true; resolveInput(null) } }

// ── Output write ──

function writeToOutput(text: string): void {
	if (!text) return
	resetHalBlink()
	const wasAtBottom = scrollOffset === 0
	const prevTotalVisual = getTotalVisualLines()
	appendOutput(text)
	const addedLines = getTotalVisualLines() - prevTotalVisual
	if (wasAtBottom) {
		scrollOffset = 0
		if (selAnchor && selAnchor.surface === 'output') {
			selAnchor = { ...selAnchor, row: selAnchor.row - addedLines }
			if (selCurrent) selCurrent = { ...selCurrent, row: selCurrent.row - addedLines }
			if ((selCurrent && selCurrent.row < 0) || selAnchor.row < 0)
				{ selAnchor = null; selCurrent = null; selActive = false }
		}
	} else scrollOffset = Math.max(0, scrollOffset + addedLines)
	render()
}

function onResize(): void {
	if (!initialized || suspended) return
	if (scrollOffset > 0 && lastRenderedTotalVisual > 0) {
		const fraction = (scrollOffset + lastRenderedOutputHeight / 2) / lastRenderedTotalVisual
		lastWrapCols = 0
		const newTotal = getTotalVisualLines()
		const newOutputHeight = Math.max(0, Math.max(1, rows() - footerHeight()) - 1)
		scrollOffset = Math.max(0, Math.round(fraction * newTotal - newOutputHeight / 2))
	} else lastWrapCols = 0
	render()
}

function onSigCont(): void {
	if (!initialized) return
	suspended = false; ended = false
	try { enterRawMode() } catch { initialized = false; process.exit(0) }
	directWrite('\x1b[?1049h'); enableMouse(); render()
}

function enterRawMode(): void {
	process.stdin.setEncoding('utf8')
	if (process.stdin.isTTY) process.stdin.setRawMode(true)
	process.stdin.resume()
}

export function flashHeader(text: string, durationMs = 1500): void {
	if (headerFlashTimer) clearTimeout(headerFlashTimer)
	headerFlash = text; if (initialized) scheduleRender()
	headerFlashTimer = setTimeout(() => { headerFlash = ''; headerFlashTimer = null; if (initialized) scheduleRender() }, durationMs)
}

// ── Serialization helpers ──

function safeStringify(value: unknown): string {
	if (typeof value === 'string') return value
	try { return stringify(value) } catch { return String(value) }
}

// ── Public API ──

export function init(): void {
	if (initialized) return
	initialized = true; ended = false; suspended = false
	inputBuf = ''; inputCursor = 0
	clearInputTextSelection(); clearInputUndoHistory()
	outputLines = ['']; scrollOffset = 0; lastWrapCols = 0; wrappedLineCount = 1
	enterRawMode()
	directWrite('\x1b[?1049h') // enter alt screen
	enableMouse()
	animTimer = setInterval(animTick, ANIM_MS)
	process.stdin.on('data', onStdinData); process.stdin.on('end', onStdinEnd)
	process.on('SIGCONT', onSigCont); process.stdout.on('resize', onResize)
	render()
}
export function write(text: string): void { writeToOutput(text) }
export function log(...args: any[]): void { write(args.map((a) => safeStringify(a)).join(' ') + '\n') }

export function setActivityLine(text: string): void {
	if (activityStr === text) return; activityStr = text; if (initialized) scheduleRender()
}
export function setTitleBar(text: string): void {
	if (titleBarStr === text) return; titleBarStr = text; if (initialized) scheduleRender()
}
export function setStatusLine(tabsStr: string, rightStr: string): void {
	statusTabsStr = tabsStr; statusRightStr = rightStr; if (initialized) scheduleRender()
}
export function getOutputSnapshot(): string { return outputLines.join('\n') }
export function setOutputSnapshot(snapshot: string): void { outputLines = ['']; lastWrapCols = 0; appendOutput(snapshot) }
export function clearOutput(): void { replaceOutput('') }
export function replaceOutput(snapshot: string): void {
	outputLines = ['']; scrollOffset = 0; lastWrapCols = 0; wrappedLineCount = 1
	if (snapshot) appendOutput(snapshot)
	if (initialized) render()
}
export function getOutputLineCount(): number { return outputLines.length }
export function updateOutputLines(startIndex: number, newLines: string[]): void {
	for (let i = 0; i < newLines.length; i++) {
		const idx = startIndex + i
		if (idx < outputLines.length) outputLines[idx] = newLines[i]
	}
	lastWrapCols = 0
	if (initialized) render()
}
export function input(promptStr: string): Promise<string | null> {
	if (!initialized) init()
	resolveInput(null); inputPromptStr = promptStr
	if (draftPreloaded) draftPreloaded = false
	else { inputBuf = ''; inputCursor = 0; clearInputTextSelection(); clearInputUndoHistory() }
	render()
	if (ended) return Promise.resolve(null)
	return new Promise((resolve) => { waitingResolve = resolve })
}
export function cancelInput(): void { resolveInput(null) }
export function prompt(message: string, promptStr: string): Promise<string | null> {
	write(`${message}\n`); return input(promptStr)
}
export { scheduleRender as render }
export function cleanup(): void {
	if (!initialized) return
	initialized = false; suspended = false
	if (animTimer) { clearInterval(animTimer); animTimer = null }
	if (headerFlashTimer) { clearTimeout(headerFlashTimer); headerFlashTimer = null }
	headerFlash = ''; dumpAndLeaveAltScreen()
	process.stdin.off('data', onStdinData); process.stdin.off('end', onStdinEnd)
	process.off('SIGCONT', onSigCont); process.stdout.off('resize', onResize)
	for (let i = 0; i < footerHeight() - 1; i++) directWrite('\r\n')
	resolveInput(null)
}
