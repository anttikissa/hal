#!/usr/bin/env bun
// Prototype: non-alternate-screen TUI with tabs
// ctrl-t: add tab, ctrl-n/ctrl-p: switch tabs, ctrl-c: exit
// Type and press Enter to generate content

const TAB_WIDTH = 4
const BOTTOM_ROWS = 2
const CLEAR_WHOLE_SCREEN_ON_FULLSCREEN = true

interface Tab {
	id: number
	lines: string[]
}

let tabs: Tab[] = [{ id: 1, lines: [] }]
let activeIdx = 0
let tabCounter = 1
let inputBuf = ''
let appTopRow = 1
let fullscreen = false

function active(): Tab { return tabs[activeIdx] }

const { stdin, stdout } = process
if (!stdin.isTTY) { console.error('Need a TTY'); process.exit(1) }
stdin.setRawMode(true)
stdin.setEncoding('utf8')
stdin.resume()

function height(): number { return stdout.rows || 24 }
function width(): number { return stdout.columns || 80 }
function scrollBottom(): number { return height() - BOTTOM_ROWS }
function scrollTop(): number { return fullscreen ? 1 : appTopRow }

function setTabStops(): void {
	stdout.write('\x1b[3g')
	for (let col = TAB_WIDTH; col < width(); col += TAB_WIDTH) {
		stdout.write(`\x1b[${col + 1}G\x1bH`)
	}
	stdout.write('\r')
}

function setScrollRegion(): void {
	const top = Math.max(1, Math.min(scrollTop(), scrollBottom()))
	stdout.write(`\x1b[${top};${scrollBottom()}r`)
}

function resetScrollRegion(): void {
	stdout.write('\x1b[r')
}

const DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m'
const BG = '\x1b[48;5;236m', ERASE = '\x1b[K'

function promptPrefix(): string { return ` tab ${active().id}> ` }

function renderStatusBar(): string {
	const parts = tabs.map((t, i) => {
		const label = ` ${t.id} `
		return i === activeIdx ? `${BOLD}[${label}]${RESET}${BG}` : `${DIM}${label}${RESET}${BG}`
	})
	return `${BG} tabs: ${parts.join(' ')} ${ERASE}${RESET}`
}

function paintBottom(): void {
	const h = height()
	const prefix = promptPrefix()
	const cursorCol = prefix.length + inputBuf.length + 1

	stdout.write('\x1b[?2026h')
	stdout.write('\x1b7')
	stdout.write(`\x1b[${h - 1};1H\x1b[2K${BG}${renderStatusBar()}`)
	stdout.write(`\x1b[${h};1H\x1b[2K${BG}${prefix}${RESET}${inputBuf}${BG}${ERASE}${RESET}`)
	stdout.write(`\x1b[${h};${cursorCol}H`)
	stdout.write('\x1b[?25h')
	stdout.write('\x1b[?2026l')
}

function paintBottomKeepContentCursor(): void {
	const h = height()
	const prefix = promptPrefix()

	stdout.write('\x1b[?2026h')
	stdout.write('\x1b7')
	stdout.write(`\x1b[${h - 1};1H\x1b[2K${BG}${renderStatusBar()}`)
	stdout.write(`\x1b[${h};1H\x1b[2K${BG}${prefix}${RESET}${inputBuf}${BG}${ERASE}${RESET}`)
	stdout.write('\x1b8')
	stdout.write('\x1b[?2026l')
}

function clearFullscreen(startRow: number): void {
	resetScrollRegion()
	if (CLEAR_WHOLE_SCREEN_ON_FULLSCREEN) {
		stdout.write('\x1b[2J\x1b[H')
		return
	}
	stdout.write(`\x1b[${Math.max(1, startRow)};1H\x1b[J\x1b[H`)
}

function repaint(clearStartRow = 1): void {
	const tab = active()
	const replay = height() * 2

	if (!fullscreen) {
		setScrollRegion()
		paintBottom()
		return
	}

	clearFullscreen(clearStartRow)
	setScrollRegion()

	const start = Math.max(0, tab.lines.length - replay)
	const toReplay = tab.lines.slice(start)
	if (toReplay.length > 0) stdout.write(toReplay.join('\r\n') + '\r\n')
	paintBottom()
}

function switchToTab(idx: number): void {
	if (idx === activeIdx) return
	activeIdx = idx
	repaint()
}

function enterFullscreen(): void {
	if (fullscreen) return
	const anchoredTop = appTopRow
	fullscreen = true
	appTopRow = 1
	repaint(anchoredTop)
}

function writeContent(text: string): void {
	stdout.write(text + '\r\n')
	paintBottomKeepContentCursor()
}

function osc8(url: string, text: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
}

function generateContent(tab: Tab, trigger: string): void {
	const n = 30
	const lines: string[] = []
	for (let i = 0; i < n; i++) {
		lines.push(`[tab ${tab.id}] line ${tab.lines.length + i}: THIS IS TAB NUMBER ${tab.id} - typed '${trigger}' - LOTS AND LOTS OF TEXT`)
	}
	lines.push(`[tab ${tab.id}] tab-test:\tcol1\tcol2\tcol3\tcol4`)
	lines.push(`[tab ${tab.id}] tab-test:\tA\tBB\tCCC\tDDDD`)
	lines.push(`[tab ${tab.id}] tab-test:\t1\t22\t333\t4444`)
	lines.push(`[tab ${tab.id}] links: ${osc8('https://github.com', 'GitHub')} | ${osc8('https://example.com/some/long/path?q=test', 'example.com')} | plain url: https://google.com`)
	lines.push(`[tab ${tab.id}] paste: [${osc8('file:///tmp/test-link.png', '/tmp/test-link.png')}]`)
	lines.push(`[tab ${tab.id}] paste: [${osc8('file:///tmp/test-link.txt', '/tmp/test-link.txt')}]`)

	for (const line of lines) tab.lines.push(line)
	stdout.write(lines.join('\r\n') + '\r\n')
	paintBottomKeepContentCursor()
}

function queryCursorPosition(): Promise<{ row: number, col: number }> {
	return new Promise((resolve) => {
		let pending = ''
		const timer = setTimeout(() => done({ row: 1, col: 1 }), 150)
		const onData = (data: string) => {
			pending += data
			const match = /\x1b\[(\d+);(\d+)R/.exec(pending)
			if (!match) return
			done({ row: Number(match[1]), col: Number(match[2]) })
		}
		const done = (pos: { row: number, col: number }) => {
			clearTimeout(timer)
			stdin.off('data', onData)
			resolve(pos)
		}
		stdin.on('data', onData)
		stdout.write('\x1b[6n')
	})
}

stdout.on('resize', () => {
	setTabStops()
	if (!fullscreen) appTopRow = Math.max(1, Math.min(appTopRow, scrollBottom()))
	repaint()
})

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
		if (tabs.length === 2) {
			enterFullscreen()
			return
		}
		repaint()
		return
	}

	if (data === '\x0e') { switchToTab((activeIdx + 1) % tabs.length); return }
	if (data === '\x10') { switchToTab((activeIdx - 1 + tabs.length) % tabs.length); return }

	if (data === '\r' || data === '\n') {
		const text = inputBuf.trim()
		inputBuf = ''
		if (text) generateContent(active(), text)
		else paintBottom()
		return
	}

	if (data === '\x7f' || data === '\x08') {
		if (inputBuf.length > 0) { inputBuf = inputBuf.slice(0, -1); paintBottom() }
		return
	}

	if (data >= ' ' && !data.startsWith('\x1b')) {
		inputBuf += data
		paintBottom()
		return
	}
})

async function init(): Promise<void> {
	setTabStops()
	stdout.write('\r\n')
	const pos = await queryCursorPosition()
	appTopRow = Math.max(1, Math.min(pos.row, scrollBottom()))
	setScrollRegion()
	stdout.write(`${DIM}ctrl-t new tab | ctrl-n/ctrl-p switch | type + enter | ctrl-c quit${RESET}\r\n`)
	paintBottomKeepContentCursor()
}

void init()

let tick = 0
setInterval(() => {
	const tab = active()
	const line = `${DIM}[tab ${tab.id}] tick ${++tick} @ ${new Date().toLocaleTimeString()}${RESET}`
	tab.lines.push(line)
	writeContent(line)
}, 1000)
