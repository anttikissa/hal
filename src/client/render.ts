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

import { client } from './app.ts'
import { prompt } from './terminal/prompt.ts'
import { popup } from './popup.ts'
import type { Block } from './app.ts'
import { renderHistory } from './render-history.ts'
import type { BlockRenderCache, HistoryRenderContext } from './render-history.ts'
import { renderStatus } from './render-status.ts'
import { cursor } from './terminal/cursor.ts'
import { terminalOutput } from './terminal-output.ts'

const config = {
	halCursorFadeFrameMs: 67,
}

const CSI = '\x1b['

// ── Diff engine state ────────────────────────────────────────────────────────
//
// These variables are the diff engine's memory between paints:
//
//   prevLines  — the frame we painted last time. Diff compares against this.
//   cursorRow  — which frame line the terminal cursor is physically on.
//   cursorCol  — which column (1-based, CSI G) the cursor is at.
//                Both MUST be updated after every cursor move, or the next
//                paint will compute wrong deltas and corrupt the display.
//   fullscreen — once the frame exceeds terminal height, we can never go
//                back to grow mode (scrollback is tainted). One-way flag.
//   blockCache — rendered block lines keyed by block object + width.

let prevLines: string[] = []
let cursorRow = 0
let cursorCol = 0
let fullscreen = false
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
	prevLines = []
	cursorRow = 0
	cursorCol = 0
	fullscreen = false
	blockCache = new WeakMap<Block, BlockRenderCache>()
	renderHistory.resetAnimation()
	if (fadeTimer) clearTimeout(fadeTimer)
	fadeTimer = null
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

function buildFrame(): { lines: string[]; cursor: { row: number; col: number } } {
	const rows = process.stdout.rows || 24
	const cols = process.stdout.columns || 80
	const chrome = renderStatus.chromeLines()
	const tab = client.currentTab()
	const lines: string[] = []

	// 1. History — all entries, all lines, NEVER sliced. See terminal.md rule 3.
	const historyLines = tab ? renderHistory.renderLines(lines, tab, cols, historyContext()) : 0

	// Update peak lazily: the focused tab now, other tabs on switch.
	if (historyLines > client.state.peak) {
		client.state.peak = historyLines
		client.state.peakCols = cols
	}

	// 2. Padding — blank lines to keep prompt at a stable row across tabs.
	const contentHeight = Math.min(client.state.peak, Math.max(0, rows - chrome))
	const padding = Math.max(0, contentHeight - lines.length)
	for (let i = 0; i < padding; i++) lines.push('')

	// Once the frame exceeds terminal height, fullscreen is permanent.
	if (lines.length + chrome > rows) fullscreen = true

	// 3. Chrome: tab bar, prompt box, status line, help bar.
	renderStatus.renderTabBar(lines)
	renderStatus.renderPrompt(lines)
	renderStatus.renderStatusLine(lines)
	renderStatus.renderHelpBar(lines)

	const popupCursor = applyPopupOverlay(lines)
	if (popupCursor) return { lines, cursor: popupCursor }

	const p = prompt.buildPrompt(renderStatus.promptContentWidth(cols))
	// Prompt sits between two rule rows, immediately above status + help.
	const promptStart = lines.length - p.lines.length - 3
	return { lines, cursor: { row: promptStart + p.cursor.rowOffset, col: Math.min(cols, p.cursor.col + 2) } }
}

function moveCursor(from: number, to: number): string {
	const d = to - from
	if (d > 0) return `${CSI}${d}B`
	if (d < 0) return `${CSI}${-d}A`
	return ''
}

// Move cursor to target and update cursorRow/cursorCol. This is the ONLY
// function that should set these (besides resetRenderer and clearFrame).
function positionCursor(from: number, target: { row: number; col: number }): string {
	cursorRow = target.row
	cursorCol = target.col
	return moveCursor(from, target.row) + `\r${renderStatus.promptCursorColorSequence()}${renderStatus.cursorShapeSequence()}${CSI}${target.col}G${CSI}?25h`
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

function repaintVisibleScreen(lines: string[], cursor: { row: number; col: number }, rows: number): void {
	// A fullscreen shrink moves the frame/scrollback boundary. Repaint every physical
	// screen row in place: CSI J makes Ghostty scroll an inspected viewport to bottom.
	const viewportTop = Math.max(0, lines.length - rows)
	const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`, `${CSI}H`]
	for (let row = 0; row < rows; row++) {
		if (row > 0) out.push('\r\n')
		out.push(`${CSI}2K${lines[viewportTop + row] ?? ''}`)
	}
	out.push(positionCursor(lines.length - 1, cursor))
	out.push(`${CSI}?2026l`)
	prevLines = lines
	writeTerminal(out.join(''))
}

function repaintFullscreenGrowth(lines: string[], cursor: { row: number; col: number }, rows: number): void {
	const oldLength = prevLines.length
	const viewportTop = Math.max(0, oldLength - rows)
	const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`, `${CSI}H`]

	// Anchor at the physical viewport top instead of trusting cursorRow: delayed
	// autowrap or terminal-side cursor movement can make that logical coordinate
	// stale. Commit the old viewport, then append only the new suffix.
	for (let i = viewportTop; i < oldLength; i++) {
		if (i > viewportTop) out.push('\r\n')
		out.push(`${CSI}2K${lines[i]!}`)
	}
	for (let i = oldLength; i < lines.length; i++) out.push(`\r\n${CSI}2K${lines[i]!}`)
	out.push(positionCursor(lines.length - 1, cursor), `${CSI}?2026l`)
	prevLines = lines
	writeTerminal(out.join(''))
}
function draw(force = false): void {
	if (terminalOutput.isExternalEditorOpen()) return
	const rows = process.stdout.rows || 24
	const screen = buildFrame()
	const lines = screen.lines
	const cursor = screen.cursor
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
		out.push(positionCursor(lines.length - 1, cursor))
		out.push(`${CSI}?2026l`)
		prevLines = lines
		writeTerminal(out.join(''))
		return
	}

	// Fullscreen frame shrink is handled after diff range calculation below.
	// Do not call draw(true) here: fullscreen force repaint emits CSI 3J, which
	// clears scrollback and snaps the user's scroll position to bottom.

	// ── Diff: find changed range ──
	let first = -1
	let last = -1
	const max = Math.max(lines.length, prevLines.length)
	for (let i = 0; i < max; i++) {
		// Compare with null so we can distinguish "line is empty string"
		// from "line doesn't exist". Without this, appending an empty line
		// (e.g. shift+enter at end of prompt → new blank prompt line) is
		// invisible to the diff because `undefined ?? ''` === `''`.
		if ((lines[i] ?? null) !== (prevLines[i] ?? null)) {
			if (first === -1) first = i
			last = i
		}
	}

	// If the first changed line is already in scrollback, we cannot move the
	// cursor there — terminals clamp cursor-up at the top of the visible screen.
	// Ignore purely offscreen changes, and clamp mixed changes to the top of the
	// live viewport so we only redraw what can actually be updated in-place.
	const viewportTop = Math.max(0, prevLines.length - rows)
	const frameShrunk = lines.length < prevLines.length
	const frameGrew = lines.length > prevLines.length
	// A shrink changes which logical frame row belongs at the viewport top.
	// Patching only the changed bottom rows leaves the old viewport anchored and
	// produces a blank row below the help bar, so repaint the visible screen.
	if (fullscreen && frameShrunk && first !== -1) {
		repaintVisibleScreen(lines, cursor, rows)
		return
	}
	if (fullscreen && frameGrew && lines.length > rows && first >= 0 && first < prevLines.length) {
		repaintFullscreenGrowth(lines, cursor, rows)
		return
	}
	if (first !== -1 && first < viewportTop) {
		if (last < viewportTop) {
			first = -1
		} else {
			first = viewportTop
		}
	}

	// ── Cursor-only: no lines changed ──
	// Common case: user moved cursor within the prompt without changing text
	// (e.g. arrow keys, Ctrl-A/E). Frame lines are identical but cursor
	// position changed. We skip the full diff machinery and just reposition.
	if (first === -1) {
		if (cursorRow === cursor.row && cursorCol === cursor.col && prevLines.length > 0) {
			scheduleFade()
			return
		}
		writeTerminal(positionCursor(cursorRow, cursor))
		return
	}

	// ── Diff repaint: rewrite from first change ──
	const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]

	// Two sub-cases: rewriting existing lines vs appending new ones.
	//
	// APPEND: first >= prevLines.length. All old lines match; we just need
	// to add new lines at the end. We move to the last existing line and
	// use \r\n to scroll into new territory. We CANNOT use CSI B to move
	// past the bottom of the screen — it's clamped and silently ignored,
	// which would make us overwrite the wrong line.
	//
	// REWRITE: first < prevLines.length. Some existing line changed. Move
	// there, overwrite from that point forward.
	const isAppend = first >= prevLines.length && prevLines.length > 0
	if (isAppend) {
		// Move to the last existing line, then \r\n into new territory.
		out.push(moveCursor(cursorRow, prevLines.length - 1))
		for (let i = first; i < lines.length; i++) {
			out.push(`\r\n${CSI}2K${lines[i]!}`)
		}
	} else {
		out.push(moveCursor(cursorRow, first))
		out.push('\r')
		for (let i = first; i < lines.length; i++) {
			if (i > first) out.push('\r\n')
			out.push(`${CSI}2K${lines[i]!}`)
		}
	}

	// Frame shrunk (e.g. multiline prompt collapsed to single line).
	// Move to the first leftover row and clear from there. Use cursor-down,
	// not CRLF: when the prompt is at the bottom of the viewport, CRLF scrolls
	// the terminal and leaves a stray blank row below the help bar.
	let lastWrittenRow = lines.length - 1
	if (lines.length < prevLines.length) {
		out.push(`\r${CSI}1B${CSI}J`)
		lastWrittenRow = lines.length // we moved one past the end
	}

	out.push(positionCursor(lastWrittenRow, cursor))
	out.push(`${CSI}?2026l`)
	prevLines = lines
	writeTerminal(out.join(''))
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

// Erase the current frame from the terminal. Used before restart (Ctrl-R)
// so the new process can paint fresh without leftover content.
function clearFrame(): void {
	if (terminalOutput.isExternalEditorOpen()) return
	if (prevLines.length === 0) return
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
	prevLines = []
	cursorRow = 0
}

function hasAnimatedIndicators(): boolean {
	return renderStatus.hasAnimatedIndicators() || renderHistory.hasAnimatedCursor(client.currentTab())
}

export const render = { config, draw, resetRenderer, invalidateHistoryCache, clearFrame, hasAnimatedIndicators }
