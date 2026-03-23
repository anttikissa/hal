// Terminal renderer — frame building + differential repaint engine.
// See docs/terminal.md for the full contract.
//
// Architecture:
//   buildFrame() produces a flat string[] — one entry per terminal row.
//   draw() diffs it against prevLines[] and emits minimal escape sequences.
//   cursorRow always reflects the physical terminal row the cursor is on.
//
// The prompt can be multiline (shift-enter). The cursor can be on any
// prompt line, not just the last one. All cursor positioning goes through
// positionCursor() which updates cursorRow atomically.

import { visLen, wordWrap, clipVisual } from '../utils/strings.ts'
import { client } from '../client.ts'
import { prompt } from '../cli/prompt.ts'
import type { Entry, Tab } from '../client.ts'

const CSI = '\x1b['

// ── Diff engine state ────────────────────────────────────────────────────────
//
// These three variables are the diff engine's memory between paints:
//
//   prevLines  — the frame we painted last time. Diff compares against this.
//   cursorRow  — which frame line the terminal cursor is physically on.
//                MUST be updated after every cursor move, or the next paint
//                will compute wrong deltas and corrupt the display.
//   fullscreen — once the frame exceeds terminal height, we can never go
//                back to grow mode (scrollback is tainted). One-way flag.

let prevLines: string[] = []
let cursorRow = 0
let fullscreen = false

// High-water mark: tallest history (in rendered lines) across all tabs.
// Grows but never shrinks. Used for padding to keep the prompt stable.
let peak = 0

// Cached line counts per tab. Invalidated when tab.history.length changes.
const lineCountCache = new WeakMap<Tab, { entryCount: number; lineCount: number }>()

function resetRenderer(): void {
	prevLines = []; cursorRow = 0; fullscreen = false; peak = 0
}

// ── Entry rendering ──────────────────────────────────────────────────────────

function formatTimestamp(ts?: number): string {
	if (ts === undefined) return ''
	const d = new Date(ts)
	const hh = String(d.getHours()).padStart(2, '0')
	const mm = String(d.getMinutes()).padStart(2, '0')
	const ss = String(d.getSeconds()).padStart(2, '0')
	const ms = String(d.getMilliseconds()).padStart(3, '0')
	return `\x1b[90m${hh}:${mm}:${ss}.${ms}\x1b[0m `
}

// ONE function that turns an entry into terminal lines. Used by both
// renderHistory() and historyLineCount(). No drift possible.
function renderEntry(entry: Entry, cols: number): string[] {
	const ts = formatTimestamp(entry.ts)
	let prefix: string
	switch (entry.type) {
		case 'input':     prefix = `${ts}\x1b[36mYou:\x1b[0m `; break
		case 'assistant': prefix = `${ts}\x1b[33mAssistant:\x1b[0m `; break
		case 'info':      prefix = ts ? `${ts}\x1b[90m` : '\x1b[90m'; break
	}
	const suffix = entry.type === 'info' ? '\x1b[0m' : ''
	const result: string[] = []
	const text = entry.text || ''
	for (const raw of text.split('\n')) {
		for (const wrapped of wordWrap(`${prefix}${raw}${suffix}`, cols)) {
			result.push(wrapped)
		}
		// After the first line, continuation lines get indentation, not the prefix.
		prefix = ts ? '                  ' : '  '
	}
	return result
}

function historyLineCount(tab: Tab): number {
	const cached = lineCountCache.get(tab)
	if (cached && cached.entryCount === tab.history.length) return cached.lineCount
	const cols = process.stdout.columns || 80
	let count = 0
	for (const entry of tab.history) count += renderEntry(entry, cols).length
	lineCountCache.set(tab, { entryCount: tab.history.length, lineCount: count })
	return count
}

// ── Frame building ───────────────────────────────────────────────────────────

function renderHistory(lines: string[], tab: Tab): void {
	const cols = process.stdout.columns || 80
	for (const entry of tab.history) {
		for (const line of renderEntry(entry, cols)) lines.push(line)
	}
}

const MAX_TABS = 40

// Tab bar: tries full names, then just numbers, then terse.
function renderTabBar(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const tabs = client.state.tabs
	const active = client.state.activeTab

	const named = tabs.map((tab, i) =>
		i === active ? `\x1b[1m[${i + 1} ${tab.name}]\x1b[0m` : `\x1b[90m ${i + 1} ${tab.name} \x1b[0m`
	)
	if (visLen(named.join('')) <= cols) { lines.push(named.join('')); return }

	const padded = tabs.map((_, i) =>
		i === active ? `\x1b[1m[${i + 1}]\x1b[0m` : `\x1b[90m ${i + 1} \x1b[0m`
	)
	if (visLen(padded.join('')) <= cols) { lines.push(padded.join('')); return }

	const terse = tabs.map((_, i) =>
		i === active ? `\x1b[1m[${i + 1}]\x1b[0m` : `\x1b[90m${i + 1}\x1b[0m`
	)
	const terseStr = terse.join(' ')
	lines.push(visLen(terseStr) > cols ? clipVisual(terseStr, cols) : terseStr)
}

function renderStatusLine(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const mode = fullscreen ? 'full' : 'grow'
	const info = ` ${client.state.role} \u00b7 pid ${process.pid} \u00b7 ${mode} `
	const dashes = Math.max(0, cols - visLen(info) - 1)
	const left = Math.floor(dashes / 2)
	const right = dashes - left
	lines.push(`\x1b[90m${'\u2500'.repeat(left)}${info}${'\u2500'.repeat(right)}\x1b[0m`)
}

function renderPrompt(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const p = prompt.buildPrompt(cols - 1)
	for (const line of p.lines) lines.push(line)
}

// How many frame lines the chrome (tab bar + status + prompt) occupies.
function chromeLines(): number {
	const cols = process.stdout.columns || 80
	return 2 + prompt.lineCount(cols - 1)
}

function buildFrame(): string[] {
	const rows = process.stdout.rows || 24
	const chrome = chromeLines()
	const tab = client.currentTab()
	const lines: string[] = []

	// 1. History — all entries, all lines, NEVER sliced. See terminal.md rule 3.
	if (tab) renderHistory(lines, tab)

	// Update peak lazily: only the active tab, inactive tabs on switch.
	if (tab) {
		const c = historyLineCount(tab)
		if (c > peak) peak = c
	}

	// 2. Padding — blank lines to keep prompt at a stable row across tabs.
	const contentHeight = Math.min(peak, Math.max(0, rows - chrome))
	const padding = Math.max(0, contentHeight - lines.length)
	for (let i = 0; i < padding; i++) lines.push('')

	// Once the frame exceeds terminal height, fullscreen is permanent.
	if (lines.length + chrome > rows) fullscreen = true

	// 3. Chrome: tab bar, status line, prompt (1+ lines).
	renderTabBar(lines)
	renderStatusLine(lines)
	renderPrompt(lines)

	return lines
}

// ── Cursor positioning ───────────────────────────────────────────────────────
//
// The prompt can be multiline. The cursor can be on any line of the prompt,
// not just the last. We compute the cursor's absolute frame row ONCE per
// draw() call — see cursorTarget(). All paint paths use the same target.
//
// positionCursor() is the ONLY way to move the cursor to a new position.
// It updates cursorRow atomically. Using raw CSI moves without updating
// cursorRow will cause the next paint to compute wrong deltas.

function cursorTarget(frameLen: number): { row: number; col: number } {
	const cols = process.stdout.columns || 80
	const p = prompt.buildPrompt(cols - 1)
	// prompt occupies the last p.lines.length rows of the frame.
	// cursor.rowOffset is 0-based within the prompt. So:
	//   absolute row = (frame end) - (prompt height) + (cursor's prompt row)
	const row = frameLen - p.lines.length + p.cursor.rowOffset
	// +1 because CSI G is 1-based
	return { row, col: p.cursor.col + 1 }
}

function moveCursor(from: number, to: number): string {
	const d = to - from
	if (d > 0) return `${CSI}${d}B`
	if (d < 0) return `${CSI}${-d}A`
	return ''
}

// Move cursor to target and update cursorRow. This is the ONLY function
// that should set cursorRow (besides resetRenderer and clearFrame).
function positionCursor(from: number, target: { row: number; col: number }): string {
	cursorRow = target.row
	return moveCursor(from, target.row) + `\r${CSI}${target.col}G${CSI}?25h`
}

// ── Paint ────────────────────────────────────────────────────────────────────
//
// Three paths:
//   1. Force repaint (force=true): clear screen, write all lines.
//   2. Diff repaint: find first changed line, rewrite from there.
//   3. Cursor-only: no lines changed, just reposition cursor.
//
// All three end with positionCursor() to place the cursor and update
// cursorRow. The cursor target is computed ONCE at the top of draw().

function draw(force = false): void {
	const rows = process.stdout.rows || 24
	const lines = buildFrame()
	const cursor = cursorTarget(lines.length)

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

	// ── Diff: find first changed line ──
	let first = -1
	const max = Math.max(lines.length, prevLines.length)
	for (let i = 0; i < max; i++) {
		if ((lines[i] ?? '') !== (prevLines[i] ?? '')) { first = i; break }
	}

	// ── Cursor-only: no lines changed ──
	// Common case: user moved cursor within the prompt without changing text
	// (e.g. arrow keys, Ctrl-A/E). Frame lines are identical but cursor
	// position changed. We skip the full diff machinery and just reposition.
	if (first === -1) {
		if (cursorRow === cursor.row && prevLines.length > 0) return
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

export const render = { draw, resetRenderer, clearFrame }
