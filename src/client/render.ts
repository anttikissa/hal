// Terminal renderer -- frame building + differential repaint engine.
// See docs/terminal.md for the full contract.
//
// Owns: frame layout, entry rendering, word wrapping, padding, chrome,
// fullscreen flag, diff engine.
//
// Does NOT own: state (tabs, entries, prompt). Reads from client.ts.

import { visLen, wordWrap, clipVisual } from '../utils/strings.ts'
import { client } from '../client.ts'
import type { Entry, Tab } from '../client.ts'

const CSI = '\x1b['

// ── Diff engine state ────────────────────────────────────────────────────────

let prevLines: string[] = []
let cursorRow = 0

// One-way flag. Once the frame exceeds terminal height, every force repaint
// must clear scrollback. See docs/terminal.md.
let fullscreen = false

// High-water mark: tallest history (in rendered lines) across all tabs.
let peak = 0

function resetRenderer(): void {
	prevLines = []
	cursorRow = 0
	fullscreen = false
	peak = 0
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
		// Continuation lines get indentation instead of prefix.
		prefix = ts ? '                  ' : '  '
	}
	return result
}

function historyLineCount(tab: Tab): number {
	const cols = process.stdout.columns || 80
	let count = 0
	for (const entry of tab.history) count += renderEntry(entry, cols).length
	return count
}

// ── Frame building ───────────────────────────────────────────────────────────

function renderHistory(lines: string[], tab: Tab): void {
	const cols = process.stdout.columns || 80
	for (const entry of tab.history) {
		for (const line of renderEntry(entry, cols)) lines.push(line)
	}
}

// Tab bar with progressive sizing. Tries formats from widest to narrowest
// until one fits the terminal width:
//   1. " [1] migit " / "  2  colors " (number + name)
//   2. " [1] mig " / "  2  col "     (number + truncated name)
//   3. " [1] " / "  2  "             (number only)
function renderTabBar(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const tabs = client.state.tabs
	const active = client.state.activeTab

	// Try format with full names.
	const full = tabs.map((tab, i) =>
		i === active ? ` [${i + 1}] ${tab.name} ` : `  ${i + 1}  ${tab.name}  `
	)
	if (visLen(full.join('')) <= cols) {
		lines.push(full.map((s, i) => i === active ? `\x1b[7m${s}\x1b[0m` : s).join(''))
		return
	}

	// Try format with truncated names (3 chars).
	const short = tabs.map((tab, i) => {
		const name = tab.name.length > 3 ? tab.name.slice(0, 3) : tab.name
		return i === active ? ` [${i + 1}] ${name} ` : `  ${i + 1}  ${name}  `
	})
	if (visLen(short.join('')) <= cols) {
		lines.push(short.map((s, i) => i === active ? `\x1b[7m${s}\x1b[0m` : s).join(''))
		return
	}

	// Numbers only.
	const nums = tabs.map((_, i) =>
		i === active ? ` [${i + 1}] ` : `  ${i + 1}  `
	)
	const numsStr = nums.map((s, i) => i === active ? `\x1b[7m${s}\x1b[0m` : s).join('')
	// If even numbers don't fit, truncate to terminal width.
	if (visLen(numsStr) > cols) {
		lines.push(clipVisual(numsStr, cols))
	} else {
		lines.push(numsStr)
	}
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
	for (const line of wordWrap(`\x1b[32m>\x1b[0m ${client.state.promptText}`, cols)) {
		lines.push(line)
	}
}

function chromeLines(): number {
	const cols = process.stdout.columns || 80
	return 2 + wordWrap(`> ${client.state.promptText}`, cols).length
}

function buildFrame(): string[] {
	const rows = process.stdout.rows || 24
	const chrome = chromeLines()
	const tab = client.currentTab()
	const lines: string[] = []

	// 1. History -- all entries, all lines, never sliced.
	if (tab) renderHistory(lines, tab)

	// Update peak across all tabs.
	for (const t of client.state.tabs) {
		const c = historyLineCount(t)
		if (c > peak) peak = c
	}

	// 2. Padding -- keeps prompt stable across tab switches.
	const contentHeight = Math.min(peak, Math.max(0, rows - chrome))
	const padding = Math.max(0, contentHeight - lines.length)
	for (let i = 0; i < padding; i++) lines.push('')

	// Check if frame exceeds terminal. Once true, never goes back.
	if (lines.length + chrome > rows) fullscreen = true

	// 3. Chrome.
	renderTabBar(lines)
	renderStatusLine(lines)
	renderPrompt(lines)

	return lines
}

function cursorCol(): number {
	const cols = process.stdout.columns || 80
	const wrapped = wordWrap(`> ${client.state.promptText}`, cols)
	return visLen(wrapped[wrapped.length - 1]!)
}

// ── Paint ────────────────────────────────────────────────────────────────────

function draw(force = false): void {
	const rows = process.stdout.rows || 24
	const lines = buildFrame()

	if (force) {
		const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]

		if (!fullscreen) {
			const up = Math.min(cursorRow, rows - 1)
			out.push('\r')
			if (up > 0) out.push(`${CSI}${up}A`)
			out.push(`${CSI}J`)
		} else {
			out.push(`${CSI}2J${CSI}H${CSI}3J`)
		}

		for (let i = 0; i < lines.length; i++) {
			if (i > 0) out.push('\r\n')
			out.push(lines[i]!)
		}
		cursorRow = lines.length - 1
		prevLines = lines
		out.push(`\r${CSI}${cursorCol() + 1}G`)
		out.push(`${CSI}?25h`, `${CSI}?2026l`)
		process.stdout.write(out.join(''))
		return
	}

	// Diff: find first changed line.
	let first = -1
	const max = Math.max(lines.length, prevLines.length)
	for (let i = 0; i < max; i++) {
		if ((lines[i] ?? '') !== (prevLines[i] ?? '')) {
			first = i
			break
		}
	}
	if (first === -1) return

	const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]
	const delta = first - cursorRow
	if (delta < 0) out.push(`${CSI}${-delta}A`)
	else if (delta > 0) out.push(`${CSI}${delta}B`)
	out.push('\r')

	for (let i = first; i < lines.length; i++) {
		if (i > first) out.push('\r\n')
		out.push(`${CSI}2K${lines[i]!}`)
	}

	cursorRow = lines.length - 1
	out.push(`\r${CSI}${cursorCol() + 1}G`)
	out.push(`${CSI}?25h`, `${CSI}?2026l`)
	prevLines = lines
	process.stdout.write(out.join(''))
}

// Erase the current frame from the terminal. Used before restart (Ctrl-R)
// so the new process can paint fresh without leftover content.
function clearFrame(): void {
	if (prevLines.length === 0) return
	const rows = process.stdout.rows || 24

	if (!fullscreen) {
		// Grow mode: we know exactly how many rows we painted. Move to top, clear down.
		const up = Math.min(cursorRow, rows - 1)
		const out = ['\r']
		if (up > 0) out.push(`${CSI}${up}A`)
		out.push(`${CSI}J`)
		process.stdout.write(out.join(''))
	} else {
		// Full mode: clear visible screen and scrollback.
		process.stdout.write(`${CSI}2J${CSI}H${CSI}3J`)
	}

	prevLines = []
	cursorRow = 0
}

export const render = { draw, resetRenderer, clearFrame }
