#!/usr/bin/env bun
// Prototype: non-alternate-screen TUI with tabs
// ctrl-t: add tab, ctrl-n/ctrl-p: switch tabs, ctrl-c: exit
// Type and press Enter to send a message

const BOTTOM_ROWS = 4 // tabs + border + prompt + border

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

function height(): number { return stdout.rows || 24 }
function width(): number { return stdout.columns || 80 }

function setScrollRegion(): void {
	stdout.write(`\x1b[1;${height() - BOTTOM_ROWS}r`)
}

function resetScrollRegion(): void {
	stdout.write('\x1b[r')
}

// ── Rendering ──
//
// \x1b7 / \x1b8 (DECSC/DECRC) tracks the content cursor position.
// Before writing content: \x1b8 (restore). After writing: \x1b7 (save).
// paintBar() uses absolute moves, ends with cursor on prompt line.

const DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m'

function renderTabsLine(): string {
	const parts = tabs.map((t, i) => {
		const label = ` ${t.id} `
		return i === activeIdx ? `${BOLD}[${label}]${RESET}` : `${DIM} ${label} ${RESET}`
	})
	return `tabs: ${parts.join('')}`
}

function hline(): string {
	return '─'.repeat(width())
}

function paintBar(): void {
	const h = height()
	const prefix = '> '
	const cursorCol = prefix.length + inputBuf.length + 1

	stdout.write('\x1b[?2026h')
	stdout.write(`\x1b[${h - 3};1H\x1b[2K${renderTabsLine()}`)
	stdout.write(`\x1b[${h - 2};1H\x1b[2K${DIM}${hline()}${RESET}`)
	stdout.write(`\x1b[${h - 1};1H\x1b[2K${prefix}${inputBuf}`)
	stdout.write(`\x1b[${h};1H\x1b[2K${DIM}${hline()}${RESET}`)
	stdout.write(`\x1b[${h - 1};${cursorCol}H\x1b[?25h`)
	stdout.write('\x1b[?2026l')
}

function writeContent(lines: string[]): void {
	if (lines.length === 0) return
	stdout.write('\x1b8')
	stdout.write(lines.join('\r\n') + '\r\n')
	stdout.write('\x1b7')
	paintBar()
}

function switchToTab(idx: number): void {
	if (idx === activeIdx) return
	activeIdx = idx
	repaint()
}

function repaint(): void {
	const tab = active()
	const replay = height() * 2

	resetScrollRegion()
	stdout.write('\x1b[3J\x1b[2J\x1b[H')
	setScrollRegion()

	const start = Math.max(0, tab.lines.length - replay)
	const toReplay = tab.lines.slice(start)
	if (toReplay.length > 0) {
		stdout.write(toReplay.join('\r\n') + '\r\n')
	}
	stdout.write('\x1b7')
	paintBar()
}

function handleMessage(tab: Tab, text: string): void {
	const spamMatch = text.match(/^spa(m+)$/)
	if (spamMatch) {
		const count = spamMatch[1].length * 30
		const lines: string[] = []
		for (let i = 0; i < count; i++) {
			lines.push(`[tab ${tab.id}] line ${tab.lines.length + i}: THIS IS TAB NUMBER ${tab.id} - LOTS AND LOTS OF TEXT BLAH BLAH BLAH`)
		}
		for (const line of lines) tab.lines.push(line)
		writeContent(lines)
	} else {
		const line = `You said: ${text}`
		tab.lines.push(line)
		writeContent([line])
	}
}

// ── Resize ──

stdout.on('resize', () => {
	setScrollRegion()
	paintBar()
})

// ── Input handling ──

stdin.on('data', (data: string) => {
	if (data === '\x03') {
		resetScrollRegion()
		stdout.write(`\x1b[${height()};1H\r\n\x1b[?25h`)
		process.exit(0)
	}

	if (data === '\x14') {
		tabCounter++
		tabs.push({ id: tabCounter, lines: [] })
		activeIdx = tabs.length - 1
		inputBuf = ''
		repaint()
		return
	}

	if (data === '\x0e') { switchToTab((activeIdx + 1) % tabs.length); return }
	if (data === '\x10') { switchToTab((activeIdx - 1 + tabs.length) % tabs.length); return }

	if (data === '\r' || data === '\n') {
		const text = inputBuf.trim()
		inputBuf = ''
		if (text) handleMessage(active(), text)
		else paintBar()
		return
	}

	if (data === '\x7f' || data === '\x08') {
		if (inputBuf.length > 0) { inputBuf = inputBuf.slice(0, -1); paintBar() }
		return
	}

	if (data >= ' ' && !data.startsWith('\x1b')) {
		inputBuf += data
		paintBar()
		return
	}
})

// ── Init ──

stdout.write('\x1b[2J\x1b[H') // clear screen + home
setScrollRegion()
stdout.write(`${DIM}ctrl-t new tab | ctrl-n/ctrl-p switch | type + enter | ctrl-c quit${RESET}\r\n`)
stdout.write('\x1b7')
paintBar()
