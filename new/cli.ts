// Terminal client — reference implementation.

import { render, emptyState, type RenderState, type CursorPos } from './cli-render.ts'
import * as cursor from './cli-cursor.ts'

// ── State ──

interface Tab {
	id: number
	lines: string[]
}

let tabs: Tab[] = [{ id: 1, lines: [''] }]
let activeIdx = 0
let tabCounter = 1
let inputBuf = ''

function active(): Tab { return tabs[activeIdx] }

/** Append text to a tab's content, like a terminal receiving characters. */
function appendText(tab: Tab, text: string): void {
	for (const ch of text) {
		if (ch === '\n') {
			tab.lines.push('')
		} else {
			tab.lines[tab.lines.length - 1] += ch
		}
	}
}

// ── Terminal setup ──

const { stdin, stdout } = process
if (!stdin.isTTY) { console.error('Need a TTY'); process.exit(1) }
stdin.setRawMode(true)
stdin.setEncoding('utf8')
stdin.resume()

function width(): number { return stdout.columns || 80 }

// ── Renderer ──

const DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m'

let renderState: RenderState = emptyState

function buildLines(): string[] {
	const tab = active()
	const maxContentLines = Math.max(...tabs.map(t => t.lines.length))
	const lines: string[] = [...tab.lines]

	// Cursor at end of content — like a text editor caret
	lines[lines.length - 1] += cursor.char()

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

function doRender(): void {
	const newLines = buildLines()
	const cursorPos: CursorPos = {
		row: newLines.length - 2,
		col: 3 + inputBuf.length,
	}
	const { buf, state } = render(newLines, renderState, cursorPos, stdout.rows || 24)
	renderState = state
	if (buf) stdout.write(buf)
}

// ── Streaming simulator ──

function simulateResponse(tab: Tab, text: string): void {
	let i = 0
	const tick = setInterval(() => {
		if (i >= text.length) { clearInterval(tick); return }
		appendText(tab, text[i])
		i++
		doRender()
	}, 30)
}

// ── Input handling ──

stdin.on('data', (data: string) => {
	if (data === '\x03') {
		cursor.stop()
		const delta = renderState.lines.length - 1 - renderState.cursorRow
		if (delta > 0) stdout.write(`\x1b[${delta}B`)
		stdout.write('\r\n\x1b[?25h')
		process.exit(0)
	}

	if (data === '\x14') {
		tabCounter++
		tabs.push({ id: tabCounter, lines: [''] })
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
					tab.lines.push(`[tab ${tab.id}] line ${tab.lines.length}: LOTS OF TEXT BLAH BLAH`)
			} else {
				appendText(tab, `> ${text}\n`)
				const words = text.split(' ').length
				const response = `Message: "${text}"\n${text.length} chars, ${words} word${words === 1 ? '' : 's'}\n`
				simulateResponse(tab, response)
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
	renderState = emptyState
	doRender()
})

cursor.start(doRender)
doRender()