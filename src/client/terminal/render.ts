// Top-level terminal renderer — frame orchestration + differential repaint.
// See docs/terminal.md for the full terminal contract.
//
// This module builds the complete screen frame: history rows from
// render-history.ts, plus tabs, prompt, status/help lines, and popups. It also
// owns the terminal diff engine that writes the frame safely.
//
// render-history.ts is separate because historical transcript rendering has its
// own rules: block grouping, hidden paused notices, assistant separators, fork
// dimming, and the idle/working HAL cursor. Keeping those out of this file makes
// this module about terminal mechanics instead of transcript semantics.
//
// cursorRow/cursorCol always reflect the physical terminal cursor position. The
// prompt can be multiline, so all cursor positioning goes through
// positionCursor() which updates cursorRow and cursorCol atomically.

import { client } from '../app.ts'
import { prompt } from './prompt.ts'
import { popup } from './popup.ts'
import type { Block } from '../app.ts'
import { renderHistory } from './render-history.ts'
import type { BlockRenderCache, HistoryRenderContext } from './render-history.ts'
import { renderStatus } from './render-status.ts'
import { cursor } from './cursor.ts'
import { terminalOutput } from './terminal-output.ts'
import { visLen, wordWrap } from '../../utils/strings.ts'
import { terminalQuestions } from './questions.ts'

const config = {
	halCursorFadeFrameMs: 67,
}

const CSI = '\x1b['

function physicalRows(line: string, cols: number): number {
	// Intentionally over-width frame lines are standalone URLs, whose printable
	// characters are single-column. That makes terminal wrapping exactly ceil(width / cols).
	return Math.max(1, Math.ceil(visLen(line) / Math.max(1, cols)))
}

function physicalHeight(lines: string[], cols: number, end = lines.length): number {
	let height = 0
	for (let i = 0; i < end; i++) height += physicalRows(lines[i]!, cols)
	return height
}

type Frame = {
	lines: string[]
	lineTops: number[]
	height: number
	cols: number
	cursor: { row: number; col: number; question?: true }
}

// A frame's strings are compared repeatedly. Reuse row heights for its unchanged
// prefix, then measure only new lines; keeping prefix heights makes cursor movement O(1).
function lineTops(lines: string[], cols: number, previous?: Frame): number[] {
	const tops = [0]
	const canReuse = previous?.cols === cols
	for (let i = 0; i < lines.length; i++) {
		let rows: number
		if (canReuse && lines[i] === previous.lines[i]) rows = previous.lineTops[i + 1]! - previous.lineTops[i]!
		else rows = physicalRows(lines[i]!, cols)
		tops.push(tops[tops.length - 1]! + rows)
	}
	return tops
}

function appendLineTops(tops: number[], lines: string[], cols: number, start: number): void {
	for (let i = start; i < lines.length; i++) tops.push(tops[tops.length - 1]! + physicalRows(lines[i]!, cols))
}

function visibleLineStart(frame: Frame, rows: number): { index: number; row: number } {
	const viewportTop = Math.max(0, frame.height - rows)
	let low = 0
	let high = frame.lines.length
	while (low < high) {
		const mid = Math.floor((low + high) / 2)
		if (frame.lineTops[mid + 1]! <= viewportTop) low = mid + 1
		else high = mid
	}
	const lineTop = frame.lineTops[low]!
	const nextTop = frame.lineTops[low + 1]!
	if (lineTop < viewportTop) return { index: low + 1, row: nextTop - viewportTop }
	return { index: low, row: lineTop - viewportTop }
}

// ── Diff engine state ────────────────────────────────────────────────────────
//
// These variables are the diff engine's memory between paints:
//
//   prevLines  — the logical frame painted last time. Diff compares strings.
//   cursorRow  — the physical row occupied by the terminal cursor.
//   cursorCol  — which column (1-based, CSI G) the cursor is at.
//                Both MUST be updated after every cursor move, or the next
//                paint will compute wrong deltas and corrupt the display.
//   fullscreen — once the frame exceeds terminal height, we can never go
//                back to grow mode (scrollback is tainted). One-way flag.
//   blockCache — rendered block lines keyed by block object + width.

let prevFrame: Frame = { lines: [], lineTops: [0], height: 0, cols: 0, cursor: { row: 0, col: 0 } }
let cursorRow = 0
let cursorCol = 0
let fullscreen = false
let paintedPopupActive = false
let blockCache = new WeakMap<Block, BlockRenderCache>()
let fadeTimer: ReturnType<typeof setTimeout> | null = null

function historyContext(): HistoryRenderContext {
	return {
		blockCache,
		cursorTick: cursor.tick(),
		workingSessions: client.state.working,
		sessionLabel: client.sessionLabel,
		sessionLabelVersion: client.state.sessionLabelVersion,
	}
}

function scheduleFade(): void {
	if (fadeTimer || !renderHistory.hasFadingCursor(client.currentTab())) return
	const delay = Math.max(1, config.halCursorFadeFrameMs)
	fadeTimer = setTimeout(() => {
		fadeTimer = null
		draw()
	}, delay)
}

function writeTerminal(s: string): void {
	if (!terminalOutput.write(s)) return
	scheduleFade()
}

function resetRenderer(): void {
	prevFrame = { lines: [], lineTops: [0], height: 0, cols: 0, cursor: { row: 0, col: 0 } }
	cursorRow = 0
	cursorCol = 0
	fullscreen = false
	paintedPopupActive = false
	blockCache = new WeakMap<Block, BlockRenderCache>()
	renderHistory.resetAnimation()
	if (fadeTimer) clearTimeout(fadeTimer)
	fadeTimer = null
}

function enterFullscreen(): void {
	// Tab workflows must be able to replace history that has already become native
	// scrollback. This mode is intentionally one-way for the renderer's lifetime.
	fullscreen = true
}

function invalidateHistoryCache(): void {
	blockCache = new WeakMap<Block, BlockRenderCache>()
}

// ── Frame building ───────────────────────────────────────────────────────────

function overlayLine(_base: string, overlay: string, x: number): string {
	return ' '.repeat(Math.max(0, x)) + overlay
}

function applyPopupOverlay(lines: string[]): { row: number; col: number } | null {
	const cols = process.stdout.columns || 80
	const rows = process.stdout.rows || 24
	const overlay = popup.buildOverlay(cols, rows)
	if (!overlay) return null
	// Popups address physical rows. Temporarily hard-wrap intentional over-width
	// URL lines so an overlay can replace one row without reflowing the rest.
	const physicalLines: string[] = []
	for (const line of lines) physicalLines.push(...wordWrap(line, cols))
	lines.splice(0, lines.length, ...physicalLines)
	const viewportTop = Math.max(0, lines.length - rows)
	const minHeight = Math.min(viewportTop + rows, viewportTop + overlay.y + overlay.lines.length)
	while (lines.length < minHeight) lines.push('')
	for (let i = 0; i < overlay.lines.length; i++) {
		const row = viewportTop + overlay.y + i
		if (row < 0 || row >= lines.length) continue
		lines[row] = overlayLine(lines[row] ?? '', overlay.lines[i]!, overlay.x)
	}
	return overlay.cursor ? { row: viewportTop + overlay.cursor.row, col: overlay.cursor.col } : null
}

function buildFrame(): Frame {
	const rows = process.stdout.rows || 24
	const cols = process.stdout.columns || 80
	terminalQuestions.activeQuestion()
	const chrome = renderStatus.chromeLines()
	const tab = client.currentTab()
	const lines: string[] = []

	// 1. History — all entries, all lines, NEVER sliced. See terminal.md rule 3.
	const historyRender = tab ? renderHistory.renderLines(lines, tab, cols, historyContext()) : undefined
	let tops = lineTops(lines, cols, prevFrame)
	const historyHeight = tops[tops.length - 1]!
	const questionCursor = historyRender?.cursor ? { row: tops[historyRender.cursor.row]!, col: historyRender.cursor.col, question: true as const } : undefined

	// Update peak lazily: the focused tab now, other tabs on switch.
	if (historyHeight > client.state.peak) {
		client.state.peak = historyHeight
		client.state.peakCols = cols
	}

	// 2. Padding — blank lines to keep prompt at a stable row across tabs.
	const contentHeight = Math.min(client.state.peak, Math.max(0, rows - chrome))
	const padding = Math.max(0, contentHeight - historyHeight)
	const paddingStart = lines.length
	for (let i = 0; i < padding; i++) lines.push('')
	appendLineTops(tops, lines, cols, paddingStart)

	// Once the frame exceeds terminal height, fullscreen is permanent.
	if (tops[tops.length - 1]! + chrome > rows) fullscreen = true

	// 3. Chrome: tab bar, prompt box, status line, help bar.
	const chromeStart = lines.length
	renderStatus.renderTabBar(lines)
	renderStatus.renderPrompt(lines)
	renderStatus.renderStatusLine(lines)
	renderStatus.renderHelpBar(lines)
	appendLineTops(tops, lines, cols, chromeStart)

	const popupCursor = applyPopupOverlay(lines)
	if (popupCursor) {
		tops = lineTops(lines, cols, prevFrame)
		return { lines, lineTops: tops, height: tops[tops.length - 1]!, cols, cursor: popupCursor }
	}
	if (questionCursor) return { lines, lineTops: tops, height: tops[tops.length - 1]!, cols, cursor: questionCursor }

	const p = prompt.buildPrompt(renderStatus.promptContentWidth(cols))
	// Prompt sits between two rule rows, immediately above status + help.
	const promptStartIndex = lines.length - p.lines.length - 3
	const promptStart = tops[promptStartIndex]!
	return { lines, lineTops: tops, height: tops[tops.length - 1]!, cols, cursor: { row: promptStart + p.cursor.rowOffset, col: Math.min(cols, p.cursor.col + 2) } }
}

function moveCursor(from: number, to: number): string {
	const d = to - from
	if (d > 0) return `${CSI}${d}B`
	if (d < 0) return `${CSI}${-d}A`
	return ''
}

// Move cursor to target and update cursorRow/cursorCol. This is the ONLY
// function that should set these (besides resetRenderer and clearFrame).
function positionCursor(from: number, target: { row: number; col: number; question?: true }): string {
	cursorRow = target.row
	cursorCol = target.col
	let visibility = `${CSI}?25l`
	if (target.question || renderStatus.config.promptOpacity > 0) visibility = `${CSI}?25h`
	return moveCursor(from, target.row) + `\r${renderStatus.promptCursorColorSequence()}${renderStatus.cursorShapeSequence()}${CSI}${target.col}G${visibility}`
}

// ── Paint ────────────────────────────────────────────────────────────────────
//
// Three paths:
//   1. Force repaint (force=true): clear screen, write all lines.
//   2. Diff repaint: find first changed line, rewrite from there.
//   3. Cursor-only: no lines changed, just reposition.
//
// All three end with positionCursor() to place the cursor and update
// cursorRow/cursorCol. The cursor target is computed ONCE at the top.


function repaintFullscreenGrowth(frame: Frame, rows: number): void {
	const oldLength = prevFrame.lines.length
	const start = visibleLineStart(prevFrame, rows)
	const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`, `\r${CSI}${rows}A`]

	// A logical URL can start above the viewport and soft-wrap into it. Its visible
	// tail is already correct, so leave it untouched and begin at the next whole line.
	if (start.row > 0) out.push(`${CSI}${Math.min(rows - 1, start.row)}B`)
	let wroteLine = false
	for (let i = start.index; i < oldLength; i++) {
		if (wroteLine) out.push('\r\n')
		out.push(`${CSI}2K${frame.lines[i]!}`)
		wroteLine = true
	}
	for (let i = oldLength; i < frame.lines.length; i++) out.push(`\r\n${CSI}2K${frame.lines[i]!}`)
	out.push(positionCursor(frame.height - 1, frame.cursor), `${CSI}?2026l`)
	prevFrame = frame
	writeTerminal(out.join(''))
}

// Recovery repaints must not use CSI J or CSI H: Ghostty follows both erase-display
// and cursor-home controls by returning an inspected scrollback viewport to the live
// bottom. A relative move up by the viewport height clamps at its physical top while
// preserving the inspected position. Split native-wrapped URLs just for this repaint
// so every physical row remains independently addressable.
function repaintVisibleScreen(frame: Frame, rows: number): void {
	const physicalLines: string[] = []
	for (const line of frame.lines) physicalLines.push(...wordWrap(line, frame.cols))
	const viewportTop = Math.max(0, physicalLines.length - rows)
	const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`, `\r${CSI}${rows}A`]
	for (let row = 0; row < rows; row++) {
		if (row > 0) out.push('\r\n')
		out.push(`${CSI}2K${physicalLines[viewportTop + row] ?? ''}`)
	}
	// A once-fullscreen frame may be shorter than an enlarged viewport; painting
	// blank rows still leaves the cursor at the viewport bottom.
	out.push(positionCursor(Math.max(frame.height, rows) - 1, frame.cursor), `${CSI}?2026l`)
	prevFrame = frame
	writeTerminal(out.join(''))
}
function draw(force = false): void {
	if (terminalOutput.isExternalEditorOpen()) return
	const rows = process.stdout.rows || 24
	const frame = buildFrame()
	const lines = frame.lines
	const cursor = frame.cursor
	// Popup frames hard-wrap soft URLs, so never diff across the two layouts.
	if (popup.state.active !== paintedPopupActive) {
		paintedPopupActive = popup.state.active
		if (fullscreen) {
			repaintVisibleScreen(frame, rows)
			return
		}
		force = true
	}
	// ── Force repaint ──
	if (force) {
		const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]
		if (!fullscreen) {
			// Grow mode: move to top of our content, clear downward.
			// Scrollback (shell history above our content) is preserved.
			const up = Math.min(cursorRow, rows - 1)
			out.push('\r')
			if (up > 0) out.push(`${CSI}${up}A`)
			out.push(`${CSI}J`)
		} else {
			// Full mode: nuke everything. Scrollback has stale content
			// from other tabs that we can't selectively update.
			out.push(`${CSI}2J${CSI}H${CSI}3J`)
		}
		for (let i = 0; i < lines.length; i++) {
			if (i > 0) out.push('\r\n')
			out.push(lines[i]!)
		}
		// After writing all lines, cursor is on the last frame line.
		// positionCursor moves it to the prompt cursor position.
		out.push(positionCursor(frame.height - 1, cursor))
		out.push(`${CSI}?2026l`)
		prevFrame = frame
		writeTerminal(out.join(''))
		return
	}

	// Fullscreen frame shrink is handled after diff range calculation below.
	// Do not call draw(true) here: fullscreen force repaint emits CSI 3J, which
	// clears scrollback and snaps the user's scroll position to bottom.

	// ── Diff: find changed range ──
	let first = -1
	let last = -1
	const max = Math.max(lines.length, prevFrame.lines.length)
	for (let i = 0; i < max; i++) {
		// Compare with null so we can distinguish "line is empty string"
		// from "line doesn't exist".
		if ((lines[i] ?? null) !== (prevFrame.lines[i] ?? null)) {
			if (first === -1) first = i
			last = i
		}
	}

	// If the first changed logical line is already in scrollback, terminals clamp
	// cursor-up at the top of the visible screen. Frame prefix heights preserve the
	// native soft-wrap semantics without repeatedly parsing every ANSI line.
	const prevHeight = prevFrame.height
	const nextHeight = frame.height
	const viewportTop = visibleLineStart(prevFrame, rows).index
	const frameShrunk = nextHeight < prevHeight
	const frameGrew = nextHeight > prevHeight
	// A shrink moves the scrollback/viewport boundary. Repaint physical rows in
	// place; CSI J would pull an inspected Ghostty viewport back to the bottom.
	if (fullscreen && frameShrunk && first !== -1) {
		repaintVisibleScreen(frame, rows)
		return
	}
	if (fullscreen && frameGrew && nextHeight > rows && first >= 0 && first < prevFrame.lines.length) {
		repaintFullscreenGrowth(frame, rows)
		return
	}
	if (first !== -1 && first < viewportTop) {
		if (last < viewportTop) first = -1
		else first = viewportTop
	}

	// ── Cursor-only: no lines changed ──

	// Common case: user moved cursor within the prompt without changing text
	// (e.g. arrow keys, Ctrl-A/E). Frame lines are identical but cursor
	// position changed, so only the terminal cursor moves.
	if (first === -1) {
		if (cursorRow === cursor.row && cursorCol === cursor.col && prevFrame.lines.length > 0) {
			scheduleFade()
			return
		}
		writeTerminal(positionCursor(cursorRow, cursor))
		return
	}

	// ── Diff repaint: rewrite from first change ──
	const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]
	const isAppend = first >= prevFrame.lines.length && prevFrame.lines.length > 0
	if (isAppend) {
		// Move to the last existing line, then \r\n into new territory.
		out.push(moveCursor(cursorRow, prevHeight - 1))
		for (let i = first; i < lines.length; i++) out.push(`\r\n${CSI}2K${lines[i]!}`)
	} else {
		out.push(moveCursor(cursorRow, prevFrame.lineTops[first]!))
		out.push('\r')
		for (let i = first; i < lines.length; i++) {
			if (i > first) out.push('\r\n')
			out.push(`${CSI}2K${lines[i]!}`)
		}
	}

	// Frame shrunk (e.g. multiline prompt collapsed to single line).
	let lastWrittenRow = nextHeight - 1
	if (frameShrunk) {
		out.push(`\r${CSI}1B${CSI}J`)
		lastWrittenRow = nextHeight // we moved one past the end
	}

	out.push(positionCursor(lastWrittenRow, cursor))
	out.push(`${CSI}?2026l`)
	prevFrame = frame
	writeTerminal(out.join(''))
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

// Erase the current frame from the terminal. Used before restart (Ctrl-R)
// so the new process can paint fresh without leftover content.
function clearFrame(): void {
	if (terminalOutput.isExternalEditorOpen()) return
	if (prevFrame.lines.length === 0) return
	const rows = process.stdout.rows || 24
	if (!fullscreen) {
		const up = Math.min(cursorRow, rows - 1)
		const out = ['\r']
		if (up > 0) out.push(`${CSI}${up}A`)
		out.push(`${CSI}J`)
		terminalOutput.write(out.join(''))
	} else {
		terminalOutput.write(`${CSI}2J${CSI}H${CSI}3J`)
	}
	prevFrame = { lines: [], lineTops: [0], height: 0, cols: 0, cursor: { row: 0, col: 0 } }
	cursorRow = 0
}

function hasAnimatedIndicators(): boolean {
	return renderStatus.hasAnimatedIndicators() || renderHistory.hasAnimatedCursor(client.currentTab())
}

export const render = { config, draw, resetRenderer, enterFullscreen, invalidateHistoryCache, clearFrame, hasAnimatedIndicators, physicalRows, physicalHeight }
