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

function buildLines(): string[] {
	const tab = active()
	const maxContentLines = Math.max(...tabs.map(t => t.lines.length))
	const lines: string[] = [...tab.lines]
	while (lines.length < maxContentLines) lines.push('')

	const parts = tabs.map((t, i) => {
		const label = ` ${t.id} `
		return i === activeIdx ? `${BOLD}[${label}]${RESET}` : `${DIM} ${label} ${RESET}`
	})
	lines.push(`tabs: ${parts.join('')}`)

	const hline = `${DIM}${'─'.repeat(width())}${RESET}`
	lines.push(hline)
	lines.push(`> ${inputBuf}`)
	const help = ' ctrl-t new tab │ ctrl-n/ctrl-p switch │ ctrl-c quit '
	const w = width()
	const pad = w - help.length
	const left = Math.max(0, Math.floor(pad / 2))
	const right = Math.max(0, pad - left)
	lines.push(`${DIM}${'─'.repeat(left)}${help}${'─'.repeat(right)}${RESET}`)

	return lines
}

// Append cursor-positioning escapes to buf, return final cursor row
function appendCursorPosition(buf: string, cursorRow: number, lines: string[]): string {
	const promptRow = lines.length - 2
	const promptCol = 3 + inputBuf.length
	const delta = promptRow - cursorRow
	if (delta > 0) buf += `\x1b[${delta}B`
	else if (delta < 0) buf += `\x1b[${-delta}A`
	buf += `\x1b[${promptCol}G\x1b[?25h`
	hardwareCursorRow = promptRow
	return buf
}

function writeBuf(lines: string[]): string {
	let buf = ''
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) buf += '\r\n'
		buf += lines[i]
	}
	return buf
}

function doRender(): void {
	const newLines = buildLines()
	const h = stdout.rows || 24

	// Full render: write all lines, optionally clearing screen first
	const fullRender = (clear: boolean): void => {
		let buf = '\x1b[?2026h'
		if (clear) buf += '\x1b[3J\x1b[2J\x1b[H'
		buf += writeBuf(newLines)
		buf = appendCursorPosition(buf, newLines.length - 1, newLines)
		buf += '\x1b[?2026l'
		stdout.write(buf)
		previousLines = newLines
	}

	if (previousLines.length === 0) { fullRender(false); return }

	// Find changed range
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

	if (firstChanged === -1) return // no changes

	// Changes above visible viewport — can't reach with relative moves
	const viewportTop = Math.max(0, previousLines.length - h)
	if (firstChanged < viewportTop) { fullRender(true); return }

	let buf = '\x1b[?2026h'

	const appendStart = newLines.length > previousLines.length
		&& firstChanged === previousLines.length
		&& firstChanged > 0
	const moveTarget = appendStart ? firstChanged - 1 : firstChanged
	const delta = moveTarget - hardwareCursorRow
	if (delta > 0) buf += `\x1b[${delta}B`
	else if (delta < 0) buf += `\x1b[${-delta}A`
	buf += appendStart ? '\r\n' : '\r'

	const renderEnd = Math.min(lastChanged, newLines.length - 1)
	for (let i = firstChanged; i <= renderEnd; i++) {
		if (i > firstChanged) buf += '\r\n'
		buf += `\x1b[2K${newLines[i]}`
	}

	let cursorRow = renderEnd

	// Clear extra lines if content shrunk
	if (previousLines.length > newLines.length) {
		const extra = previousLines.length - newLines.length
		if (renderEnd < newLines.length - 1) {
			buf += `\x1b[${newLines.length - 1 - renderEnd}B`
			cursorRow = newLines.length - 1
		}
		for (let i = 0; i < extra; i++) buf += '\r\n\x1b[2K'
		buf += `\x1b[${extra}A`
	}

	buf = appendCursorPosition(buf, cursorRow, newLines)
	buf += '\x1b[?2026l'
	stdout.write(buf)
	previousLines = newLines
}

// ── Input handling ──

stdin.on('data', (data: string) => {
	if (data === '\x03') {
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

	if (data === '\x0e') { activeIdx = (activeIdx + 1) % tabs.length; doRender(); return }
	if (data === '\x10') { activeIdx = (activeIdx - 1 + tabs.length) % tabs.length; doRender(); return }

	if (data === '\r' || data === '\n') {
		const text = inputBuf.trim()
		inputBuf = ''
		if (text) {
			const tab = active()
			const spamMatch = text.match(/^spa(m+)$/)
			if (spamMatch) {
				const count = spamMatch[1].length * 30
				for (let i = 0; i < count; i++)
					tab.lines.push(`[tab ${tab.id}] line ${tab.lines.length}: THIS IS TAB NUMBER ${tab.id} - LOTS AND LOTS OF TEXT BLAH BLAH BLAH`)
			} else {
				tab.lines.push(`You said: ${text}`)
			}
		}
		doRender()
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

stdout.on('resize', () => {
	previousLines = []
	hardwareCursorRow = 0
	doRender()
})

doRender()
