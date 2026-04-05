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

import { visLen, clipVisual } from '../utils/strings.ts'
import { blocks as blockRenderer } from '../cli/blocks.ts'
import { helpBar } from '../cli/help-bar.ts'
import { client } from '../client.ts'
import { models } from '../models.ts'
import { auth } from '../auth.ts'
import { git } from '../utils/git.ts'
import { prompt } from '../cli/prompt.ts'
import { cursor } from '../cli/cursor.ts'
import type { Block, Tab } from '../client.ts'

const CSI = '\x1b['

// ── Diff engine state ────────────────────────────────────────────────────────
//
// These three variables are the diff engine's memory between paints:
//
//   prevLines  — the frame we painted last time. Diff compares against this.
//   cursorRow  — which frame line the terminal cursor is physically on.
//   cursorCol  — which column (1-based, CSI G) the cursor is at.
//                Both MUST be updated after every cursor move, or the next
//                paint will compute wrong deltas and corrupt the display.
//   fullscreen — once the frame exceeds terminal height, we can never go
//                back to grow mode (scrollback is tainted). One-way flag.

let prevLines: string[] = []
let cursorRow = 0
let cursorCol = 0
let fullscreen = false

// peak lives in client.state.peak (persisted across restarts).
// Local alias for readability.

// Cached line counts per tab. Invalidated when tab.history.length changes.
const lineCountCache = new WeakMap<Tab, { entryCount: number; lineCount: number }>()

function resetRenderer(): void {
	prevLines = []
	cursorRow = 0
	cursorCol = 0
	fullscreen = false
}

// ── Entry rendering ──────────────────────────────────────────────────────────

// ONE function that turns a block into terminal lines. Used by both
// renderHistory() and historyLineCount(). No drift possible.
function renderEntry(block: Block, cols: number): string[] {
	return blockRenderer.renderBlock(block, cols)
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
	for (let i = 0; i < tab.history.length; i++) {
		// Blank line between blocks (not before the first)
		if (i > 0) lines.push('')
		for (const line of renderEntry(tab.history[i]!, cols)) lines.push(line)
	}
	// Live streaming blocks — shown while the model is generating.
	// These are ephemeral (not in history) and replaced by the final
	// response/thinking blocks when the stream ends.
	const hasContent = lines.length > 0
	if (tab.streamingThinking) {
		if (hasContent) lines.push('')
		const block: Block = { type: 'thinking', text: tab.streamingThinking }
		for (const line of renderEntry(block, cols)) lines.push(line)
	}
	if (tab.streamingText) {
		if (hasContent || tab.streamingThinking) lines.push('')
		const block: Block = { type: 'assistant', text: tab.streamingText }
		for (const line of renderEntry(block, cols)) lines.push(line)
	}
}

const MAX_TABS = 40

// ── Tab status indicator ─────────────────────────────────────────────────────
//
// Each tab gets a 1-char-wide status indicator (all visLen === 1):
//   •  busy (blinking: visible on even phases, space on odd)
//   ✓  generation done, user hasn't looked at this tab yet (green)
//   !  interrupted/paused (blinking)
//   ✗  ended with error (red, blinking)
//      (space) idle, nothing notable

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const BRIGHT_WHITE = '\x1b[97m'
const DIM = '\x1b[38;5;245m'
const RESET = '\x1b[0m'
const INPUT_CURSOR_COLOR = '\x1b[38;5;75m' // matches prompt cursor color

function tabIndicator(tab: Tab): { char: string; color: string; blinks: boolean } {
	const busy = client.state.busy.get(tab.sessionId) ?? false

	if (busy) return { char: '•', color: INPUT_CURSOR_COLOR, blinks: true }

	if (tab.doneUnseen) return { char: '✓', color: GREEN, blinks: false }

	// Check if the last meaningful block is an error or interruption
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const b = tab.history[i]!
		// Skip trailing info blocks that aren't status-relevant
		if (b.type === 'info' && b.text !== '[paused]' && !b.text?.startsWith('[interrupted]')) continue
		if (b.type === 'error') return { char: '✗', color: RED, blinks: true }
		if (b.type === 'info' && (b.text === '[paused]' || b.text?.startsWith('[interrupted]'))) {
			return { char: '!', color: '', blinks: true }
		}
		break
	}

	return { char: '', color: '', blinks: false }
}

// Render the 1-char indicator, respecting blink phase.
// Returns empty string when there's nothing to show (idle tab, no errors).
function renderIndicator(tab: Tab, baseColor: string): string {
	const ind = tabIndicator(tab)
	if (!ind.char) return ''
	if (ind.blinks && !cursor.isVisible()) return ' '
	return `${ind.color}${ind.char}${baseColor}`
}

// Tab bar: tries full names, then just numbers, then terse.
// Each tab shows a 1-char status indicator between the number and title.
function renderTabBar(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const tabs = client.state.tabs
	const active = client.state.activeTab

	// Helper: build the inner part of a tab label.
	// ind is '' (idle), ' ' (blink-off), or colored char (blink-on).
	// When there's a name, ind (or a space if idle) separates number and name.
	function inner(num: number, ind: string, name?: string): string {
		if (name) return `${num}${ind || ' '}${name}`
		return `${num}${ind}`
	}

	const named = tabs.map((tab, i) => {
		const ind = renderIndicator(tab, i === active ? BRIGHT_WHITE : DIM)
		return i === active
			? `${BRIGHT_WHITE}[${inner(i + 1, ind, tab.name)}]${RESET}`
			: `${DIM} ${inner(i + 1, ind, tab.name)} ${RESET}`
	})
	if (visLen(named.join('')) <= cols) {
		lines.push(named.join(''))
		return
	}

	const padded = tabs.map((tab, i) => {
		const ind = renderIndicator(tab, i === active ? BRIGHT_WHITE : DIM)
		return i === active
			? `${BRIGHT_WHITE}[${inner(i + 1, ind)}]${RESET}`
			: `${DIM} ${inner(i + 1, ind)} ${RESET}`
	})
	if (visLen(padded.join('')) <= cols) {
		lines.push(padded.join(''))
		return
	}

	const terse = tabs.map((tab, i) => {
		const ind = renderIndicator(tab, i === active ? BRIGHT_WHITE : DIM)
		return i === active
			? `${BRIGHT_WHITE}[${inner(i + 1, ind)}]${RESET}`
			: `${DIM}${inner(i + 1, ind)}${RESET}`
	})
	const terseStr = terse.join(' ')
	lines.push(visLen(terseStr) > cols ? clipVisual(terseStr, cols) : terseStr)
}

// Shorten a path for display: replace $HOME with ~, then abbreviate.
function shortenPath(p: string): string {
	if (!p) return ''
	const home = process.env.HOME ?? ''
	if (home && p.startsWith(home)) p = '~' + p.slice(home.length)
	return p
}

// Color for context usage percentage.
function contextColor(pct: number): string {
	const t = models.contextThresholds
	if (pct >= t.redAbove) return '\x1b[31m'    // red
	if (pct >= t.orangeAbove) return '\x1b[33m'  // yellow/orange
	if (pct < t.greenBelow) return '\x1b[32m'    // green
	return ''                                     // default (dim)
}

function renderStatusLine(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const tab = client.currentTab()
	const parts: string[] = []

	if (tab) {
		// 0. Session ID + process identity.
		parts.push(tab.sessionId)
		parts.push(`${client.state.role}:${client.state.pid}`)
		// 1. Model name (with "(sub)" suffix if using OAuth token)
		const modelId = tab.model || client.state.model || models.defaultModel()
		const modelDisplay = models.displayModel(modelId)
		const provider = models.providerName(modelId)
		const isSub = !auth.isApiKey(provider)
		if (modelDisplay) parts.push(isSub ? `${modelDisplay} (sub)` : modelDisplay)

		// 2. Cumulative token count (input + output)
		const totalTokens = tab.usage.input + tab.usage.output
		if (totalTokens > 0) parts.push(models.formatTokenCount(totalTokens) + ' tok')

		// 3. Cost (API key only — sub users already have the "(sub)" tag)
		if (!isSub) {
			const cost = models.formatCost(modelId, tab.usage)
			if (cost) parts.push(cost)
		}

		// 4. Context usage: "25.4k/200k (13%)"
		if (tab.contextMax > 0) {
			const pct = Math.round((tab.contextUsed / tab.contextMax) * 100)
			const color = contextColor(pct)
			const reset = color ? '\x1b[90m' : ''
			parts.push(
				`${models.formatTokenCount(tab.contextUsed)}/${models.formatTokenCount(tab.contextMax)} (${color}${pct}%${reset})`,
			)
		}

		// 5. Working directory, shortened
		const cwd = shortenPath(tab.cwd)
		if (cwd) parts.push(cwd)

		// 6. Git branch (omit if "main")
		if (tab.cwd) {
			const branch = git.currentBranch(tab.cwd)
			if (branch && branch !== 'main') parts.push(branch)
		}
	}

	const info = parts.length > 0 ? ` ${parts.join(' \u00b7 ')} ` : ' '
	const dashes = Math.max(0, cols - visLen(info))
	lines.push(`\x1b[90m${info}${'\u2500'.repeat(dashes)}\x1b[0m`)
}

function renderHelpBar(lines: string[]): void {
	const busy = client.isBusy()
	const hasText = prompt.text().length > 0
	const bar = helpBar.build(busy, hasText)
	if (bar) lines.push(`\x1b[90m${bar}\x1b[0m`)
}

function renderPrompt(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const p = prompt.buildPrompt(cols)
	for (const line of p.lines) lines.push(line)
}

// How many frame lines the chrome (tab bar + status + help bar + prompt) occupies.
function chromeLines(): number {
	const cols = process.stdout.columns || 80
	const busy = client.isBusy()
	const hasText = prompt.text().length > 0
	const hasHelp = helpBar.build(busy, hasText) !== ''
	return 2 + (hasHelp ? 1 : 0) + prompt.lineCount(cols)
}

function buildFrame(): string[] {
	const rows = process.stdout.rows || 24
	const cols = process.stdout.columns || 80
	const chrome = chromeLines()
	const tab = client.currentTab()
	const lines: string[] = []

	// 1. History — all entries, all lines, NEVER sliced. See terminal.md rule 3.
	if (tab) renderHistory(lines, tab)

	// Update peak lazily: only the active tab, inactive tabs on switch.
	if (tab) {
		const c = historyLineCount(tab)
		if (c > client.state.peak) {
			client.state.peak = c
			client.state.peakCols = cols
		}
	}

	// 2. Padding — blank lines to keep prompt at a stable row across tabs.
	const contentHeight = Math.min(client.state.peak, Math.max(0, rows - chrome))
	const padding = Math.max(0, contentHeight - lines.length)
	for (let i = 0; i < padding; i++) lines.push('')

	// Once the frame exceeds terminal height, fullscreen is permanent.
	if (lines.length + chrome > rows) fullscreen = true

	// 3. Chrome: tab bar, status line, help bar, prompt (1+ lines).
	renderTabBar(lines)
	renderStatusLine(lines)
	renderHelpBar(lines)
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
// It updates cursorRow and cursorCol atomically. Using raw CSI moves without
// updating these will cause the next paint to compute wrong deltas.

function cursorTarget(frameLen: number): { row: number; col: number } {
	const cols = process.stdout.columns || 80
	const p = prompt.buildPrompt(cols)
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
//   3. Cursor-only: no lines changed, just reposition cursor.
//
// All three end with positionCursor() to place the cursor and update
// cursorRow/cursorCol. The cursor target is computed ONCE at the top.

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
		// Compare with null so we can distinguish "line is empty string"
		// from "line doesn't exist". Without this, appending an empty line
		// (e.g. shift+enter at end of prompt → new blank prompt line) is
		// invisible to the diff because `undefined ?? ''` === `''`.
		if ((lines[i] ?? null) !== (prevLines[i] ?? null)) {
			first = i
			break
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

export const render = { draw, resetRenderer, clearFrame }
