#!/usr/bin/env bun

// term.ts -- Terminal UI skeleton for Hal.
//
// The frame is built by three render functions:
//   renderHistory()    -- all history entries for the active tab
//   renderStatusLine() -- tab bar + status info
//   renderPrompt()     -- "> " + user input (word-wrapped)
//
// These push lines into an array. The diff engine compares against
// the previous frame and writes only what changed.
//
// NEVER slice history to viewport. See docs/terminal.md rule 3.

import { visLen, wordWrap } from './src/utils/strings.ts'

const CSI = '\x1b['

// ── Types ────────────────────────────────────────────────────────────────────

type Entry =
	| { type: 'user'; text: string }
	| { type: 'echo'; text: string }
	| { type: 'info'; text: string }

interface Tab {
	history: Entry[]
}

// ── State ────────────────────────────────────────────────────────────────────

const tabs: Tab[] = [{ history: [] }]
let activeTab = 0
let promptText = ''
let prevLines: string[] = []
let cursorRow = 0

// High-water mark: tallest history (in lines) across all tabs. Never shrinks.
let peak = 0

// One-way flag. Once the frame exceeds terminal height, every force repaint
// must clear scrollback. See docs/terminal.md "fullscreen flag".
let fullscreen = false

// ── Frame building ───────────────────────────────────────────────────────────

// Count how many terminal lines a tab's history produces.
function historyLineCount(tab: Tab): number {
	let count = 0
	for (const entry of tab.history) {
		count += entry.text.split('\n').length
	}
	return count
}

function renderHistory(lines: string[], tab: Tab): void {
	for (const entry of tab.history) {
		switch (entry.type) {
			case 'user':
				for (const line of entry.text.split('\n')) lines.push(`> ${line}`)
				break
			case 'echo':
				for (const line of entry.text.split('\n')) lines.push(`  ${line}`)
				break
			case 'info':
				for (const line of entry.text.split('\n')) lines.push(line)
				break
		}
	}
}

function renderStatusLine(lines: string[], tab: Tab): void {
	// Tab bar: same width per entry -- "[N]" active, " N " inactive.
	const tabBar = tabs.map((_, i) =>
		i === activeTab ? `[${i + 1}]` : ` ${i + 1} `
	).join('')

	const mode = fullscreen ? 'full' : 'grow'
	const count = historyLineCount(tab)
	lines.push(tabBar)
	lines.push(`-- ${count} lines / peak ${peak} / ${mode} --`)
}

function renderPrompt(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const wrapped = wordWrap(`> ${promptText}`, cols)
	for (const line of wrapped) lines.push(line)
}

// How many lines chrome occupies (tab bar + status + wrapped prompt).
function chromeLines(): number {
	const cols = process.stdout.columns || 80
	return 2 + wordWrap(`> ${promptText}`, cols).length
}

function buildFrame(): string[] {
	const rows = process.stdout.rows || 24
	const chrome = chromeLines()
	const tab = tabs[activeTab]!
	const lines: string[] = []

	// 1. History -- all entries, all lines, never sliced.
	renderHistory(lines, tab)

	// Update peak across all tabs.
	for (const t of tabs) {
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
	renderStatusLine(lines, tab)
	renderPrompt(lines)

	return lines
}

// ── Diff engine ──────────────────────────────────────────────────────────────

// Where to put the cursor after painting. The cursor sits at the end of the
// prompt text, which may be on a wrapped continuation line.
function cursorTarget(totalLines: number): string {
	const cols = process.stdout.columns || 80
	const wrapped = wordWrap(`> ${promptText}`, cols)
	// Cursor column: visible width of the last wrapped line (end of typed text).
	const lastLine = wrapped[wrapped.length - 1]!
	const col = visLen(lastLine)
	// CSI G is 1-indexed.
	return `\r${CSI}${col + 1}G`
}

function paint(force = false): void {
	const rows = process.stdout.rows || 24
	const lines = buildFrame()

	if (force) {
		const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]

		if (!fullscreen) {
			// GROW MODE: frame fits on screen. Rewrite in place.
			const up = Math.min(cursorRow, rows - 1)
			out.push('\r')
			if (up > 0) out.push(`${CSI}${up}A`)
			out.push(`${CSI}J`)
		} else {
			// FULL MODE: must clear scrollback.
			out.push(`${CSI}2J${CSI}H${CSI}3J`)
		}

		for (let i = 0; i < lines.length; i++) {
			if (i > 0) out.push('\r\n')
			out.push(lines[i])
		}
		cursorRow = lines.length - 1
		prevLines = lines
		out.push(cursorTarget(lines.length))
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
		out.push(`${CSI}2K${lines[i]}`)
	}

	cursorRow = lines.length - 1
	out.push(cursorTarget(lines.length))
	out.push(`${CSI}?25h`, `${CSI}?2026l`)
	prevLines = lines
	process.stdout.write(out.join(''))
}

// ── Input handling ───────────────────────────────────────────────────────────

function timestamp(): string {
	const d = new Date()
	const hh = String(d.getHours()).padStart(2, '0')
	const mm = String(d.getMinutes()).padStart(2, '0')
	const ss = String(d.getSeconds()).padStart(2, '0')
	const ms = String(d.getMilliseconds()).padStart(3, '0')
	return `${hh}:${mm}:${ss}.${ms}`
}

function handleSubmit(): void {
	if (!promptText) { paint(); return }

	const tab = tabs[activeTab]!
	const tag = `[tab ${activeTab + 1} ${timestamp()}]`

	tab.history.push({ type: 'user', text: `${tag} ${promptText}` })

	const n = parseInt(promptText, 10)
	if (n > 0 && String(n) === promptText) {
		for (let j = 0; j < n; j++) {
			tab.history.push({ type: 'info', text: `${tag} line ${historyLineCount(tab)}` })
		}
	} else {
		tab.history.push({ type: 'echo', text: `${tag} You wrote: ${promptText}` })
	}
	promptText = ''
	paint()
}

function switchTab(index: number): void {
	if (index === activeTab) return
	activeTab = index
	paint(true)
}

function handleInput(data: Buffer): void {
	for (let i = 0; i < data.length; i++) {
		const b = data[i]!

		if (b === 0x03 || b === 0x04) {
			if (process.stdin.isTTY) process.stdin.setRawMode(false)
			process.stdout.write('\r\n')
			process.exit(0)
		}
		if (b === 0x0c) { paint(true); continue }
		if (b === 0x14) { tabs.push({ history: [] }); switchTab(tabs.length - 1); continue }
		if (b === 0x17) {
			if (tabs.length > 1) {
				tabs.splice(activeTab, 1)
				if (activeTab >= tabs.length) activeTab = tabs.length - 1
				paint(true)
			}
			continue
		}
		if (b === 0x0e) { switchTab((activeTab + 1) % tabs.length); continue }
		if (b === 0x10) { switchTab((activeTab - 1 + tabs.length) % tabs.length); continue }
		if (b === 0x0d || b === 0x0a) { handleSubmit(); continue }
		if ((b === 0x7f || b === 0x08) && promptText.length) {
			promptText = promptText.slice(0, -1); paint(); continue
		}
		if (b >= 0x20 && b < 0x7f) {
			promptText += String.fromCharCode(b); paint(); continue
		}
	}
}

// ── Startup ──────────────────────────────────────────────────────────────────

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.on('resize', () => paint(true))
paint()
process.stdin.on('data', handleInput)
