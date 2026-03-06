// Terminal client — reference implementation.

import { render, emptyState, type RenderState, type CursorPos } from './cli-render.ts'
import { parseKey } from './cli-keys.ts'
import * as prompt from './cli-prompt.ts'

// ── State ──

interface Tab {
	id: number
	lines: string[]
}

let tabs: Tab[] = [{ id: 1, lines: [''] }]
let activeIdx = 0
let tabCounter = 1
let halCursorVisible = true

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

// Kitty keyboard protocol — enables Cmd+key detection
const KITTY_KBD_ON = '\x1b[>27u', KITTY_KBD_OFF = '\x1b[<u'
const TERM_RESET = `${KITTY_KBD_OFF}\x1b[?25h` // disable protocol + show cursor
const kittyTerms = /^(kitty|ghostty|iTerm\.app)$/
if (kittyTerms.test(process.env.TERM_PROGRAM ?? '')) stdout.write(KITTY_KBD_ON)

// Always restore terminal on exit, even on crash
process.on('exit', () => stdout.write(TERM_RESET))

function cols(): number { return stdout.columns || 80 }
function contentWidth(): number { return cols() - 2 }

// ── Renderer ──

const DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m'

let renderState: RenderState = emptyState

function buildLines(): { lines: string[]; cursor: CursorPos } {
	const tab = active()
	const maxContentLines = Math.max(...tabs.map(t => t.lines.length))
	const lines: string[] = [...tab.lines]
	lines[lines.length - 1] += halCursorVisible ? '█' : ' '

	const w = cols()
	const cw = contentWidth()
	const pLines = prompt.lineCount(cw)
	const chromeLines = 3 + pLines // tab bar + separator + prompt lines + help bar
	const maxPad = Math.min(maxContentLines, Math.max(0, (stdout.rows || 24) - chromeLines))
	while (lines.length < maxPad) lines.push('')

	// Tab bar
	const parts = tabs.map((t, i) => {
		const label = ` ${t.id} `
		return i === activeIdx ? `${BOLD}[${label}]${RESET}` : `${DIM} ${label} ${RESET}`
	})
	lines.push(`tabs: ${parts.join('')}`)

	// Prompt
	const p = prompt.buildPrompt(w, cw)
	lines.push(p.separator)
	lines.push(...p.lines)
	const cursorPos: CursorPos = {
		row: lines.length - pLines + p.cursor.rowOffset,
		col: p.cursor.col,
	}

	// Help bar
	const help = ' ctrl-t new │ ctrl-n/p switch │ alt-enter newline │ ctrl-c quit '
	const pad = w - help.length
	const left = Math.max(0, Math.floor(pad / 2))
	const right = Math.max(0, pad - left)
	lines.push(`${DIM}${'─'.repeat(left)}${help}${'─'.repeat(right)}${RESET}`)

	return { lines, cursor: cursorPos }
}

function doRender(): void {
	const { lines, cursor: cursorPos } = buildLines()
	const { buf, state } = render(lines, renderState, cursorPos, stdout.rows || 24)
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

function quit(): void {
	const delta = renderState.lines.length - 1 - renderState.cursorRow
	if (delta > 0) stdout.write(`\x1b[${delta}B`)
	stdout.write('\r\n')
	process.exit(0)
}

function closeTab(): void {
	if (tabs.length <= 1) { quit(); return }
	tabs.splice(activeIdx, 1)
	if (activeIdx >= tabs.length) activeIdx = tabs.length - 1
	prompt.reset()
	doRender()
}
// ── Input handling ──

stdin.on('data', (data: string) => {
	const k = parseKey(data)
	if (!k) return

	// Ctrl-C: quit
	if (k.key === 'c' && k.ctrl) { quit(); return }

	// Ctrl-W: close tab (or quit if last)
	// Ctrl-D: close tab when prompt empty (handled as delete by prompt otherwise)
	if ((k.key === 'w' && k.ctrl) || (k.key === 'd' && k.ctrl && prompt.text().length === 0)) {
		closeTab()
		return
	}

	// Ctrl-T: new tab
	if (k.key === 't' && k.ctrl) {
		tabCounter++
		tabs.push({ id: tabCounter, lines: [''] })
		activeIdx = tabs.length - 1
		prompt.reset()
		doRender()
		return
	}

	// Ctrl-N / Ctrl-P: switch tabs
	if (k.key === 'n' && k.ctrl) { activeIdx = (activeIdx + 1) % tabs.length; doRender(); return }
	if (k.key === 'p' && k.ctrl) { activeIdx = (activeIdx - 1 + tabs.length) % tabs.length; doRender(); return }

	// Enter: submit (prompt returns false for plain enter)
	if (k.key === 'enter' && !k.alt && !k.ctrl && !k.cmd) {
		const text = prompt.text().trim()
		prompt.reset()
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

	// Delegate to prompt key handler
	if (prompt.handleKey(k, contentWidth())) {
		doRender()
		return
	}
})

stdout.on('resize', () => {
	renderState = emptyState
	doRender()
})

setInterval(() => { halCursorVisible = !halCursorVisible; doRender() }, 530)
doRender()
