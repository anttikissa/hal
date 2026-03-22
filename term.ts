#!/usr/bin/env bun

// term.ts — Terminal UI skeleton for Hal.
//
// Layout (top to bottom):
//   [history lines...]   — per-tab, append-only, ALL of them, NEVER sliced
//   [padding]            — blank lines to keep prompt stable across tab switches
//   [tab bar]            — [1]  2   3  — brackets for active, spaces for inactive
//   [status bar]         — line count for active tab
//   [prompt]             — "> " + user input
//
// Rendering: differential. See docs/terminal.md.
//
// IMPORTANT: we render ALL history lines. NEVER slice to viewport. The diff
// engine ensures only changed lines are rewritten. New lines are appended
// via \r\n so the terminal scrolls naturally and old content enters scrollback.
//
// Tab switches use force repaint (the diff engine can't reach lines that
// have scrolled into the terminal's scrollback buffer).

const CSI = '\x1b['

// ── State ────────────────────────────────────────────────────────────────────

interface Tab {
	history: string[]
}

const tabs: Tab[] = [{ history: [] }]
let activeTab = 0
let promptText = ''
let prevLines: string[] = []
let cursorRow = 0

// High-water mark: the tallest content area we've ever needed.
// Grows when any tab's history exceeds it. Never shrinks.
let maxContentHeight = 0

// ── Tab bar ──────────────────────────────────────────────────────────────────

// Each entry is the same width: "[N]" for active, " N " for inactive.
function renderTabBar(): string {
	return tabs.map((_, i) =>
		i === activeTab ? `[${i + 1}]` : ` ${i + 1} `
	).join('')
}

// ── Rendering ────────────────────────────────────────────────────────────────

// Chrome = tab bar + status + prompt = 3 lines.
const CHROME = 3

function buildFrame(): string[] {
	const rows = process.stdout.rows || 24
	const tab = tabs[activeTab]!

	// Update high-water mark.
	for (const t of tabs) {
		if (t.history.length > maxContentHeight) maxContentHeight = t.history.length
	}

	// Padding: keeps the prompt at a stable row across tab switches.
	// contentHeight is the tallest any tab has been, capped at terminal size.
	const contentHeight = Math.min(maxContentHeight, Math.max(0, rows - CHROME))
	const padding = Math.max(0, contentHeight - tab.history.length)

	return [
		...tab.history,              // ALL history. Never sliced.
		...Array(padding).fill(''),  // Padding between history and chrome.
		renderTabBar(),
		`── ${tab.history.length} lines ──`,
		`> ${promptText}`,
	]
}

function paint(force = false): void {
	const rows = process.stdout.rows || 24
	const lines = buildFrame()

	if (force) {
		// FORCE REPAINT (Ctrl-L, resize, tab switch).
		// Two modes depending on whether the frame fits on screen.
		const fitsOnScreen = lines.length <= rows
		const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]

		if (fitsOnScreen) {
			// MODE 1: frame fits on screen.
			// Move to top of our content, clear from there down, rewrite.
			// Scrollback is untouched — pre-app shell history survives.
			const up = Math.min(cursorRow, rows - 1)
			out.push('\r')
			if (up > 0) out.push(`${CSI}${up}A`)
			out.push(`${CSI}J`)
		} else {
			// MODE 2: frame is taller than the terminal.
			// CSI nA can't reach scrollback — it's immutable. We MUST clear
			// scrollback first, then rewrite ALL lines from scratch.
			out.push(`${CSI}2J${CSI}H${CSI}3J`)
		}

		for (let i = 0; i < lines.length; i++) {
			if (i > 0) out.push('\r\n')
			out.push(lines[i])
		}
		cursorRow = lines.length - 1
		prevLines = lines
		out.push(`\r${CSI}${promptText.length + 3}G`)
		out.push(`${CSI}?25h`, `${CSI}?2026l`)
		process.stdout.write(out.join(''))
		return
	}

	// NORMAL REPAINT: diff against previous frame.
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
	out.push(`\r${CSI}${promptText.length + 3}G`)
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
	tab.history.push(`${tag} > ${promptText}`)

	const n = parseInt(promptText, 10)
	if (n > 0 && String(n) === promptText) {
		for (let j = 0; j < n; j++) tab.history.push(`${tag} line ${tab.history.length}`)
	} else {
		tab.history.push(`${tag} You wrote: ${promptText}`)
	}
	promptText = ''
	paint()
}

function switchTab(index: number): void {
	if (index === activeTab) return
	activeTab = index
	// Tab switch must force repaint — the diff engine can't reach lines
	// that have scrolled into the terminal's scrollback buffer.
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

		// Ctrl-T: new tab.
		if (b === 0x14) {
			tabs.push({ history: [] })
			switchTab(tabs.length - 1)
			continue
		}

		// Ctrl-W: close tab (not the last one).
		if (b === 0x17) {
			if (tabs.length > 1) {
				tabs.splice(activeTab, 1)
				if (activeTab >= tabs.length) activeTab = tabs.length - 1
				paint(true)
			}
			continue
		}

		// Ctrl-N: next tab (wraps).
		if (b === 0x0e) {
			switchTab((activeTab + 1) % tabs.length)
			continue
		}

		// Ctrl-P: previous tab (wraps).
		if (b === 0x10) {
			switchTab((activeTab - 1 + tabs.length) % tabs.length)
			continue
		}

		if (b === 0x0d || b === 0x0a) { handleSubmit(); continue }

		if ((b === 0x7f || b === 0x08) && promptText.length) {
			promptText = promptText.slice(0, -1)
			paint(); continue
		}

		if (b >= 0x20 && b < 0x7f) {
			promptText += String.fromCharCode(b)
			paint(); continue
		}
	}
}

// ── Startup ──────────────────────────────────────────────────────────────────

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.on('resize', () => paint(true))
paint()
process.stdin.on('data', handleInput)
