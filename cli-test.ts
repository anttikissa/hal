#!/usr/bin/env bun
// Prototype: Pi-style diff-rendered TUI
// No alternate screen, no scroll regions, no absolute positioning.
// Everything is one flat array of lines, diff-rendered with relative cursor moves.

// ── State ──

interface Tab {
	id: number
	lines: string[]
}

let tabs: Tab[] = [{ id: 1, lines: [] }]
let activeIdx = 0
let tabCounter = 1
let inputBuf = ''

function active(): Tab { return tabs[activeIdx] }

// ── Terminal setup ──

const { stdin, stdout } = process
if (!stdin.isTTY) { console.error('Need a TTY'); process.exit(1) }
stdin.setRawMode(true)
stdin.setEncoding('utf8')
stdin.resume()

function width(): number { return stdout.columns || 80 }

// ── Diff renderer ──

const DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m'

let previousLines: string[] = []
let hardwareCursorRow = 0

// Build the full screen as a flat array: content lines + bar + prompt
function buildLines(): string[] {
	const tab = active()
	const lines: string[] = [...tab.lines]

	// Tab bar
	const parts = tabs.map((t, i) => {
		const label = ` ${t.id} `
		return i === activeIdx ? `${BOLD}[${label}]${RESET}` : `${DIM} ${label} ${RESET}`
	})
	lines.push(`tabs: ${parts.join('')}`)

	// Border + prompt + border
	const hline = `${DIM}${'─'.repeat(width())}${RESET}`
	lines.push(hline)
	lines.push(`> ${inputBuf}`)
	lines.push(hline)

	return lines
}

function doRender(): void {
	const newLines = buildLines()
	const w = width()

	// First render — just write everything
	if (previousLines.length === 0) {
		let buf = '\x1b[?2026h'
		for (let i = 0; i < newLines.length; i++) {
			if (i > 0) buf += '\r\n'
			buf += newLines[i]
		}
		buf += '\x1b[?2026l'
		stdout.write(buf)
		hardwareCursorRow = newLines.length - 1
		previousLines = newLines
		positionCursor(newLines)
		return
	}

	// Find first and last changed lines
	let firstChanged = -1
	let lastChanged = -1
	const maxLen = Math.max(newLines.length, previousLines.length)
	for (let i = 0; i < maxLen; i++) {
		const oldLine = i < previousLines.length ? previousLines[i] : ''
		const newLine = i < newLines.length ? newLines[i] : ''
		if (oldLine !== newLine) {
			if (firstChanged === -1) firstChanged = i
			lastChanged = i
		}
	}

	// No changes
	if (firstChanged === -1) {
		positionCursor(newLines)
		return
	}

	let buf = '\x1b[?2026h'

	// If new lines were appended and first change is at the append boundary,
	// move to end of old content and start with \r\n
	const appendStart = newLines.length > previousLines.length
		&& firstChanged === previousLines.length
		&& firstChanged > 0

	const moveTarget = appendStart ? firstChanged - 1 : firstChanged

	// Move cursor from hardwareCursorRow to moveTarget using relative moves
	const delta = moveTarget - hardwareCursorRow
	if (delta > 0) buf += `\x1b[${delta}B`
	else if (delta < 0) buf += `\x1b[${-delta}A`

	buf += appendStart ? '\r\n' : '\r'

	// Render changed lines
	const renderEnd = Math.min(lastChanged, newLines.length - 1)
	for (let i = firstChanged; i <= renderEnd; i++) {
		if (i > firstChanged) buf += '\r\n'
		buf += `\x1b[2K${newLines[i]}`
	}

	let cursorRow = renderEnd

	// If old content was longer, clear extra lines
	if (previousLines.length > newLines.length) {
		const extra = previousLines.length - newLines.length
		// Move to end of new content if not already there
		if (renderEnd < newLines.length - 1) {
			const moveDown = newLines.length - 1 - renderEnd
			buf += `\x1b[${moveDown}B`
			cursorRow = newLines.length - 1
		}
		for (let i = 0; i < extra; i++) {
			buf += '\r\n\x1b[2K'
		}
		// Move back up
		buf += `\x1b[${extra}A`
	}

	buf += '\x1b[?2026l'
	stdout.write(buf)

	hardwareCursorRow = cursorRow
	previousLines = newLines

	positionCursor(newLines)
}

// Position cursor on the prompt line, after input text
function positionCursor(lines: string[]): void {
	// Prompt is the second-to-last line (before bottom border)
	const promptRow = lines.length - 2
	const promptCol = 3 + inputBuf.length // "> " = 2 chars + 1-based

	const rowDelta = promptRow - hardwareCursorRow
	let buf = ''
	if (rowDelta > 0) buf += `\x1b[${rowDelta}B`
	else if (rowDelta < 0) buf += `\x1b[${-rowDelta}A`
	buf += `\x1b[${promptCol}G` // absolute column (this is fine, not row)
	buf += '\x1b[?25h' // show cursor
	stdout.write(buf)
	hardwareCursorRow = promptRow
}

// ── Commands ──

function handleMessage(tab: Tab, text: string): void {
	const spamMatch = text.match(/^spa(m+)$/)
	if (spamMatch) {
		const count = spamMatch[1].length * 30
		for (let i = 0; i < count; i++) {
			tab.lines.push(`[tab ${tab.id}] line ${tab.lines.length}: THIS IS TAB NUMBER ${tab.id} - LOTS AND LOTS OF TEXT BLAH BLAH BLAH`)
		}
	} else {
		tab.lines.push(`You said: ${text}`)
	}
	doRender()
}

function switchToTab(idx: number): void {
	if (idx === activeIdx) return
	activeIdx = idx
	// Clear screen and re-render from scratch
	const newLines = buildLines()
	let buf = '\x1b[?2026h'
	buf += '\x1b[2J\x1b[H' // clear screen + home cursor
	for (let i = 0; i < newLines.length; i++) {
		if (i > 0) buf += '\r\n'
		buf += newLines[i]
	}
	buf += '\x1b[?2026l'
	stdout.write(buf)
	hardwareCursorRow = newLines.length - 1
	previousLines = newLines
	positionCursor(newLines)
}

// ── Resize ──

stdout.on('resize', () => {
	// Force full re-render by clearing previousLines
	previousLines = []
	hardwareCursorRow = 0
	// TODO: this is a bit rough — for now just re-render
	doRender()
})

// ── Input handling ──

stdin.on('data', (data: string) => {
	if (data === '\x03') {
		// Move below our rendered area before exiting
		const delta = previousLines.length - 1 - hardwareCursorRow
		if (delta > 0) stdout.write(`\x1b[${delta}B`)
		stdout.write('\r\n\x1b[?25h')
		process.exit(0)
	}

	if (data === '\x14') {
		tabCounter++
		tabs.push({ id: tabCounter, lines: [] })
		activeIdx = tabs.length - 1
		inputBuf = ''
		doRender()
		return
	}

	if (data === '\x0e') { switchToTab((activeIdx + 1) % tabs.length); return }
	if (data === '\x10') { switchToTab((activeIdx - 1 + tabs.length) % tabs.length); return }

	if (data === '\r' || data === '\n') {
		const text = inputBuf.trim()
		inputBuf = ''
		if (text) handleMessage(active(), text)
		else doRender()
		return
	}

	if (data === '\x7f' || data === '\x08') {
		if (inputBuf.length > 0) { inputBuf = inputBuf.slice(0, -1); doRender() }
		return
	}

	if (data >= ' ' && !data.startsWith('\x1b')) {
		inputBuf += data
		doRender()
		return
	}
})

// ── Init ──

active().lines.push(`${DIM}ctrl-t new tab | ctrl-n/ctrl-p switch | type + enter | ctrl-c quit${RESET}`)
doRender()
