// Terminal renderer — frame building + differential repaint engine.
// See docs/terminal.md for the full contract.
//
// Architecture:
//   buildFrame() produces a flat string[] — one entry per terminal row.
//   draw() diffs it against prevLines[] and emits minimal escape sequences.
//   cursorRow/cursorCol always reflect the physical terminal cursor position.
//
// The prompt can be multiline (shift-enter). The cursor can be on any
// prompt line, not just the last one. All cursor positioning goes through
// positionCursor() which updates cursorRow and cursorCol atomically.
//
// History and status helpers live in dedicated modules now, but renderer-owned
// diff/fullscreen/cursor/cache state stays centralized here.

import { client } from '../client.ts'
import { prompt } from '../cli/prompt.ts'
import { popup } from './popup.ts'
import type { Block } from '../client.ts'
import { renderHistory } from './render-history.ts'
import type { BlockRenderCache, HistoryRenderContext } from './render-history.ts'
import { renderStatus } from './render-status.ts'
import { cursor as blinkCursor } from '../cli/cursor.ts'

const config = {
	forkHistoryDimFactor: 0.85,
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

function historyContext(): HistoryRenderContext {
	return {
		forkHistoryDimFactor: config.forkHistoryDimFactor,
		blockCache,
		cursorVisible: blinkCursor.isVisible(),
	}
}

function resetRenderer(): void {
	prevLines = []
	cursorRow = 0
	cursorCol = 0
	fullscreen = false
	blockCache = new WeakMap<Block, BlockRenderCache>()
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

	// Update peak lazily: only the active tab, inactive tabs on switch.
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

	// 3. Chrome: tab bar, status line, help bar, prompt (1+ lines).
	renderStatus.renderTabBar(lines)
	renderStatus.renderStatusLine(lines)
	renderStatus.renderHelpBar(lines)
	renderStatus.renderPrompt(lines)

	const popupCursor = applyPopupOverlay(lines)
	if (popupCursor) return { lines, cursor: popupCursor }

	const p = prompt.buildPrompt(cols)
	const row = lines.length - p.lines.length + p.cursor.rowOffset
	return { lines, cursor: { row, col: p.cursor.col + 1 } }
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
	return moveCursor(from, target.row) + `\r${CSI}${target.col}G${CSI}?25h`
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

function draw(force = false): void {
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
		process.stdout.write(out.join(''))
		return
	}

	// ── Fullscreen + frame size changed: force repaint ──
	// In fullscreen mode, some lines are in scrollback (immutable). When the
	// frame shrinks, the scrollback/visible boundary shifts and the diff
	// engine's line→row mapping is wrong. The only safe recovery is a full
	// repaint that clears scrollback and rewrites everything.
	// Growth is handled by the append path below (new lines at the bottom
	// scroll naturally), but shrinks cannot be fixed incrementally.
	if (fullscreen && lines.length < prevLines.length) {
		return draw(true)
	}

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
		if (cursorRow === cursor.row && cursorCol === cursor.col && prevLines.length > 0) return
		process.stdout.write(positionCursor(cursorRow, cursor))
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
	// Erase leftover rows below the new frame end. CSI J clears from
	// cursor to end of screen without touching scrollback.
	let lastWrittenRow = lines.length - 1
	if (lines.length < prevLines.length) {
		out.push(`\r\n${CSI}J`)
		lastWrittenRow = lines.length // we moved one past the end
	}

	out.push(positionCursor(lastWrittenRow, cursor))
	out.push(`${CSI}?2026l`)
	prevLines = lines
	process.stdout.write(out.join(''))
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

// Erase the current frame from the terminal. Used before restart (Ctrl-R)
// so the new process can paint fresh without leftover content.
function clearFrame(): void {
	if (prevLines.length === 0) return
	const rows = process.stdout.rows || 24
	if (!fullscreen) {
		const up = Math.min(cursorRow, rows - 1)
		const out = ['\r']
		if (up > 0) out.push(`${CSI}${up}A`)
		out.push(`${CSI}J`)
		process.stdout.write(out.join(''))
	} else {
		process.stdout.write(`${CSI}2J${CSI}H${CSI}3J`)
	}
	prevLines = []
	cursorRow = 0
}

function hasAnimatedIndicators(): boolean {
	return renderStatus.hasAnimatedIndicators() || renderHistory.hasAnimatedCursor(client.currentTab())
}

export const render = { config, draw, resetRenderer, invalidateHistoryCache, clearFrame, hasAnimatedIndicators }
