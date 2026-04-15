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
import { oklch } from '../utils/oklch.ts'
import { blocks as blockRenderer } from '../cli/blocks.ts'
import { helpBar } from '../cli/help-bar.ts'
import { client } from '../client.ts'
import { models } from '../models.ts'
import { auth } from '../auth.ts'
import { openaiUsage } from '../openai-usage.ts'
import { version } from '../version.ts'
import { HAL_DIR } from '../state.ts'
import { colors } from '../cli/colors.ts'
import { prompt } from '../cli/prompt.ts'
import { cursor } from '../cli/cursor.ts'
import { popup } from './popup.ts'
import type { Block, Tab } from '../client.ts'

const config = {
	forkHistoryDimFactor: 0.85,
}

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

type BlockRenderCache = {
	version: number
	cols: number
	lines: string[]
}

let blockCache = new WeakMap<Block, BlockRenderCache>()

type HistoryRenderCache = {
	version: number
	length: number
	cols: number
	lines: string[]
	count: number
}

let historyCache = new WeakMap<Tab, HistoryRenderCache>()

// peak lives in client.state.peak (persisted across restarts).
// Local alias for readability.

function resetRenderer(): void {
	prevLines = []
	cursorRow = 0
	cursorCol = 0
	fullscreen = false
	blockCache = new WeakMap<Block, BlockRenderCache>()
	historyCache = new WeakMap<Tab, HistoryRenderCache>()
}

function invalidateHistoryCache(): void {
	blockCache = new WeakMap<Block, BlockRenderCache>()
	historyCache = new WeakMap<Tab, HistoryRenderCache>()
}

// ── Entry rendering ──────────────────────────────────────────────────────────

function renderEntry(block: Block, cols: number): string[] {
	const cached = blockCache.get(block)
	const version = block.renderVersion ?? 0
	if (cached && cached.version === version && cached.cols === cols) return cached.lines
	const lines = blockRenderer.renderBlock(block, cols)
	const rendered = block.dimmed ? lines.map((l) => oklch.dimAnsi(l, config.forkHistoryDimFactor)) : lines
	blockCache.set(block, { version, cols, lines: rendered })
	return rendered
}

function infoGroupKey(block: Block): string | null {
	// Only coalesce simple one-line info blocks. Multiline output such as
	// `/config` should render as a normal block so its internal line breaks
	// survive instead of being flattened into bracket "bricks".
	if (block.type !== 'info' || !block.ts || block.text.includes('\n')) return null
	const d = new Date(block.ts)
	return `info:${d.getHours()}:${d.getMinutes()}`
}

function renderGroup(group: Block[], cols: number): string[] {
	const lines = group.length === 1
		? renderEntry(group[0]!, cols)
		: blockRenderer.renderBlockGroup(group as Array<{ type: 'info' | 'warning' | 'error'; text: string; ts?: number; dimmed?: boolean }>, cols)
	// Dim grouped blocks if any block in the group is dimmed (groups are same-type, so all or none)
	return group[0]?.dimmed ? lines.map((l) => oklch.dimAnsi(l, config.forkHistoryDimFactor)) : lines
}

function shouldHideBlock(history: Block[], index: number): boolean {
	const block = history[index]
	if (!block) return false

	// Steering already tells the user why generation stopped. Hiding the
	// immediately preceding [paused] notice keeps the history focused on the
	// steering prompt instead of showing a redundant status block right before it.
	if (block.type !== 'info' || block.text !== '[paused]') return false
	const next = history[index + 1]
	return next?.type === 'user' && next.status === 'steering'
}

function visibleHistory(history: Block[]): Block[] {
	const visible: Block[] = []
	for (let i = 0; i < history.length; i++) {
		if (shouldHideBlock(history, i)) continue
		visible.push(history[i]!)
	}
	return visible
}

// ── Frame building ───────────────────────────────────────────────────────────

function renderHistory(lines: string[], tab: Tab): number {
	const cols = process.stdout.columns || 80
	const history = visibleHistory(tab.history)
	let count = 0
	for (let i = 0; i < history.length; ) {
		const group = [history[i]!]
		const key = infoGroupKey(group[0]!)
		if (key) {
			for (let j = i + 1; j < history.length && infoGroupKey(history[j]!) === key; j++) {
				group.push(history[j]!)
			}
		}
		if (lines.length > 0) lines.push('')
		const rendered = renderGroup(group, cols)
		count += rendered.length
		lines.push(...rendered)
		i += group.length
	}
	return count
}

const MAX_TABS = 40

// ── Tab status indicator ─────────────────────────────────────────────────────
//
// Each tab gets a 1-char-wide status indicator (all visLen === 1):
//   ▪  busy (blinking: bright on even phases, dim on odd)
//   ✗  ended with error (red, blinking)
//   !  ended with warning (yellow)
//   !  interrupted/paused (blinking)
//   ✓  generation done, user hasn't looked at this tab yet (green)
//      (space) idle, nothing notable

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const BRIGHT_WHITE = '\x1b[97m'
const DIM = '\x1b[38;5;245m'
const RESET = '\x1b[0m'
const ANSI_DIM = '\x1b[2m'
const INPUT_CURSOR_COLOR = '\x1b[38;5;75m' // matches prompt cursor color

function tabIndicator(tab: Tab): { char: string; color: string; blinks: boolean } {
	const busy = client.state.busy.get(tab.sessionId) ?? false

	if (busy) return { char: '▪', color: INPUT_CURSOR_COLOR, blinks: true }

	// Alerts beat the generic "done unseen" checkmark. This matters for cases
	// like "Hit max iterations" where generation finished, but the tab still
	// needs attention.
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const b = tab.history[i]!
		// Skip trailing info blocks that aren't status-relevant.
		if (b.type === 'info' && b.text !== '[paused]' && !b.text?.startsWith('[interrupted]')) continue
		if (b.type === 'warning') return { char: '!', color: YELLOW, blinks: false }
		if (b.type === 'error') return { char: '✗', color: RED, blinks: true }
		if (b.type === 'info' && (b.text === '[paused]' || b.text?.startsWith('[interrupted]'))) {
			return { char: '!', color: '', blinks: true }
		}
		break
	}

	if (tab.doneUnseen) return { char: '✓', color: GREEN, blinks: false }

	return { char: '', color: '', blinks: false }
}

function hasAnimatedIndicators(): boolean {
	for (const tab of client.state.tabs) {
		if (tabIndicator(tab).blinks) return true
	}
	return false
}

// Render the 1-char indicator. Animated indicators pulse between bright and dim
// phases instead of disappearing, so a busy tab never looks idle.
function renderIndicator(tab: Tab, baseColor: string): string {
	const ind = tabIndicator(tab)
	if (!ind.char) return ''
	if (!ind.blinks || cursor.isVisible()) return `${ind.color}${ind.char}${baseColor}`
	return `${ANSI_DIM}${ind.color}${ind.char}${RESET}${baseColor}`
}

// Tab bar: prefers [n dir name], then [n name], then just numbers.
// Each tab shows a 1-char status indicator between the number and title.
function renderTabBar(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const tabs = client.state.tabs
	const active = client.state.activeTab

	function tabDir(tab: Tab): string {
		return tab.cwd.split('/').filter(Boolean).pop() ?? ''
	}

	function inner(num: number, ind: string, text?: string): string {
		if (text) return `${num}${ind || ' '}${text}`
		return `${num}${ind}`
	}

	function label(tab: Tab, i: number, mode: 'wide' | 'name' | 'num'): string {
		const ind = renderIndicator(tab, i === active ? BRIGHT_WHITE : DIM)
		const name = tab.name || tab.sessionId
		const dir = tabDir(tab)
		const text = mode === 'wide'
			? (dir && dir !== name ? `${dir} ${name}` : name)
			: mode === 'name'
				? name
				: ''
		const content = inner(i + 1, ind, text)
		if (i === active) return `${BRIGHT_WHITE}[${content}]${RESET}`
		return `${DIM} ${content} ${RESET}`
	}

	for (const mode of ['wide', 'name', 'num'] as const) {
		const rendered = tabs.map((tab, i) => label(tab, i, mode))
		const joined = rendered.join('')
		if (visLen(joined) <= cols) {
			lines.push(joined)
			return
		}
	}

	const terse = tabs.map((tab, i) => label(tab, i, 'num'))
	lines.push(clipVisual(terse.join(''), cols))
}

// Shorten a path for display: replace $HOME with ~, then abbreviate.
function shortenPath(p: string): string {
	if (!p) return ''
	const home = process.env.HOME ?? ''
	if (home && p.startsWith(home)) p = '~' + p.slice(home.length)
	return p
}

function statusBaseColor(): string {
	return colors.status.fg || DIM
}

function statusHighlightColor(): string {
	return colors.status.highlight || BRIGHT_WHITE
}

function colorText(text: string, color: string, base: string): string {
	if (!text || !color) return text
	return `${color}${text}${base}`
}

function heatText(text: string, pct: number, base: string): string {
	return colorText(text, oklch.usageFg(pct), base)
}

function hasCustomSessionName(tab: Tab): boolean {
	return !!tab.name && tab.name !== tab.sessionId && !/^tab \d+$/i.test(tab.name)
}

function currentHalDir(): string {
	return process.env.HAL_DIR ?? HAL_DIR
}

function sessionStatusLabel(tab: Tab, base: string): string {
	if (!hasCustomSessionName(tab)) return tab.sessionId
	return `${colorText(tab.name, statusHighlightColor(), base)} (${tab.sessionId})`
}

function cwdStatusLabel(tab: Tab, base: string): string {
	const cwd = shortenPath(tab.cwd)
	if (!cwd) return ''
	const color = tab.cwd === currentHalDir() ? colors.assistant.fg : statusHighlightColor()
	return colorText(cwd, color, base)
}

function modelStatusLabel(modelId: string, base: string): string {
	const display = models.displayModel(modelId)
	if (!display) return ''
	return colorText(display, statusHighlightColor(), base)
}

function contextStatusLabel(tab: Tab, base: string): string {
	if (tab.contextMax <= 0) return ''
	const pct = Math.round((tab.contextUsed / tab.contextMax) * 100)
	const used = heatText(models.formatTokenCount(tab.contextUsed), pct, base)
	const max = models.formatTokenCount(tab.contextMax)
	const percent = heatText(`${pct}%`, pct, base)
	return `${used}/${max} (${percent})`
}

function joinStatusParts(parts: string[]): string {
	return parts.filter(Boolean).join(' · ')
}

function hostMismatchBadge(): string {
	if (client.state.role !== 'client') return ''
	if (client.state.hostVersionStatus !== 'ready') return ''
	if (version.state.status !== 'ready') return ''
	if (!client.state.hostVersion || !version.state.combined) return ''
	return client.state.hostVersion === version.state.combined ? '' : ' ≠host'
}

function serverStatusLabel(): string {
	if (client.state.role === 'client') return `client:${client.state.pid} / server:${client.state.hostPid ?? '?'}${hostMismatchBadge()}`
	return `server:${client.state.pid}`
}

function formatTotalTokens(total: number): string {
	if (total >= 1_000_000) {
		const millions = total / 1_000_000
		return `${millions.toFixed(millions >= 10 ? 0 : 1)}M`
	}
	return models.formatTokenCount(total)
}

function tokenUsageLabel(
	usage: { input: number; output: number; cacheRead: number; cacheCreation: number },
	long = false,
): string {
	const total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation
	if (total <= 0) return ''
	// Show cache hit rate when cacheRead is a meaningful fraction of total input tokens processed.
	const totalInput = usage.input + usage.cacheRead + usage.cacheCreation
	const hitRate = totalInput > 0 ? Math.round((usage.cacheRead / totalInput) * 100) : 0
	const cacheHint = hitRate >= 5 ? ` CR:${hitRate}%` : ''
	return `${formatTotalTokens(total)} ${long ? 'tokens' : 'tok'}${cacheHint}`
}

function subscriptionStatusLabel(base: string): string {
	const current = openaiUsage.current()
	if (!current) return ''
	const windows: string[] = []
	if (current.primary) {
		const pct = Math.round(current.primary.usedPercent)
		windows.push(`5h ${heatText(`${pct}%`, pct, base)}`)
	}
	if (current.secondary) {
		const pct = Math.round(current.secondary.usedPercent)
		windows.push(`7d ${heatText(`${pct}%`, pct, base)}`)
	}
	const slot = current.index != null && current.total ? ` ${current.index + 1}/${current.total}` : ''
	if (windows.length === 0) return `Sub${slot}`
	return `Sub${slot}: ${windows.join(', ')}`
}

function renderStatusLine(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const base = statusBaseColor()
	const tab = client.currentTab()
	if (!tab) {
		const blank = cols > 1 ? ` ${' '.repeat(Math.max(0, cols - 2))} ` : ' '
		lines.push(`${base}${clipVisual(blank, cols)}${RESET}`)
		return
	}

	const modelId = tab.model || client.state.model || models.defaultModel()
	const provider = models.providerName(modelId)
	const isSub = !auth.isApiKey(provider)
	const left = joinStatusParts([
		sessionStatusLabel(tab, base),
		cwdStatusLabel(tab, base),
		modelStatusLabel(modelId, base),
		contextStatusLabel(tab, base),
	])

	const server = serverStatusLabel()
	const tokenShort = tokenUsageLabel(tab.usage, false)
	const tokenLong = tokenUsageLabel(tab.usage, true)
	const plan = provider === 'openai' && isSub ? subscriptionStatusLabel(base) : ''
	const innerWidth = Math.max(0, cols - 2)
	let showServer = !!server
	let showTokens = !!tokenShort
	let showPlan = !!plan
	let inner = ''

	while (true) {
		const shortRight = joinStatusParts([
			showServer ? server : '',
			showTokens ? tokenShort : '',
			showPlan ? plan : '',
		])
		const longRight = joinStatusParts([
			showServer ? server : '',
			showTokens ? tokenLong : '',
			showPlan ? plan : '',
		])
		const right = showTokens && tokenLong && innerWidth - visLen(left) - visLen(longRight) >= 10 ? longRight : shortRight
		const needsDrop = right && innerWidth - visLen(left) - visLen(right) < 1
		if (needsDrop) {
			if (showServer) {
				showServer = false
				continue
			}
			if (showTokens) {
				showTokens = false
				continue
			}
			if (showPlan) {
				showPlan = false
				continue
			}
		}

		if (!right) {
			const clippedLeft = visLen(left) > innerWidth ? clipVisual(left, innerWidth) : left
			inner = clippedLeft + ' '.repeat(Math.max(0, innerWidth - visLen(clippedLeft)))
			break
		}

		const maxLeft = Math.max(0, innerWidth - visLen(right) - 1)
		const clippedLeft = visLen(left) > maxLeft ? clipVisual(left, maxLeft) : left
		const gap = Math.max(1, innerWidth - visLen(clippedLeft) - visLen(right))
		inner = clippedLeft + ' '.repeat(gap) + right
		break
	}

	const line = cols >= 2 ? ` ${inner} ` : inner
	lines.push(`${base}${visLen(line) > cols ? clipVisual(line, cols) : line}${RESET}`)
}

function renderHelpBar(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const busy = client.isBusy()
	const hasText = prompt.text().length > 0
	const canContinue = client.canContinueCurrentTurn()
	const bar = helpBar.build(busy, hasText, canContinue)
	// Always push a line — even when empty — so chrome height is constant.
	// Without this, typing the first character causes a 1-row jump.
	lines.push(bar ? `\x1b[90m${clipVisual(bar, cols)}\x1b[0m` : '')
}

function renderPrompt(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const p = prompt.buildPrompt(cols)
	for (const line of p.lines) lines.push(line)
}

// How many frame lines the chrome (tab bar + status + help bar + prompt) occupies.
// Help bar always counts as 1 line (even when empty) to prevent jumps.
function chromeLines(): number {
	const cols = process.stdout.columns || 80
	return 3 + prompt.lineCount(cols) // tab bar + status + help bar + prompt
}

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
	const chrome = chromeLines()
	const tab = client.currentTab()
	const lines: string[] = []

	// 1. History — all entries, all lines, NEVER sliced. See terminal.md rule 3.
	const historyLines = tab ? renderHistory(lines, tab) : 0

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
	renderTabBar(lines)
	renderStatusLine(lines)
	renderHelpBar(lines)
	renderPrompt(lines)

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
//   3. Cursor-only: no lines changed, just reposition cursor.
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

export const render = { config, draw, resetRenderer, invalidateHistoryCache, clearFrame, hasAnimatedIndicators }
