// Terminal client — reference implementation.

import { render, emptyState, type RenderState, type CursorPos } from './cli-render.ts'
import { parseKey } from './cli-keys.ts'
import * as tabs from './cli-tabs.ts'
import * as prompt from './cli-prompt.ts'

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
let halCursorVisible = true
let renderState: RenderState = emptyState

function buildLines(): { lines: string[]; cursor: CursorPos } {
	const tab = tabs.active()
	const allTabs = tabs.all()
	const maxContentLines = Math.max(...allTabs.map(t => t.lines.length))
	const lines: string[] = [...tab.lines]
	lines[lines.length - 1] += halCursorVisible ? '█' : ' '

	const w = cols()
	const cw = contentWidth()
	const pLines = prompt.lineCount(cw)
	const chromeLines = 3 + pLines
	const maxPad = Math.min(maxContentLines, Math.max(0, (stdout.rows || 24) - chromeLines))
	while (lines.length < maxPad) lines.push('')

	// Tab bar
	const idx = tabs.activeIndex()
	const parts = allTabs.map((t, i) => {
		const label = ` ${t.id} `
		return i === idx ? `${BOLD}[${label}]${RESET}` : `${DIM} ${label} ${RESET}`
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
	const help = ' ctrl-t new │ ctrl-w close │ ctrl-n/p switch │ ctrl-c quit '
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

function simulateResponse(tab: ReturnType<typeof tabs.active>, text: string): void {
	let i = 0
	const tick = setInterval(() => {
		if (i >= text.length) { clearInterval(tick); return }
		tabs.appendText(tab, text[i])
		i++
		doRender()
	}, 30)
}

// ── Quit / Close ──

function quit(): void {
	const delta = renderState.lines.length - 1 - renderState.cursorRow
	if (delta > 0) stdout.write(`\x1b[${delta}B`)
	stdout.write('\r\n')
	process.exit(0)
}

function closeTab(): void {
	if (!tabs.closeCurrent()) { quit(); return }
	prompt.reset()
	doRender()
}

// ── Input handling ──

stdin.on('data', (data: string) => {
	const k = parseKey(data)
	if (!k) return

	if (k.key === 'c' && k.ctrl) { quit(); return }

	if ((k.key === 'w' && k.ctrl) || (k.key === 'd' && k.ctrl && prompt.text().length === 0)) {
		closeTab()
		return
	}

	if (k.key === 't' && k.ctrl) {
		tabs.create()
		prompt.reset()
		doRender()
		return
	}

	if (k.key === 'n' && k.ctrl) { tabs.next(); doRender(); return }
	if (k.key === 'p' && k.ctrl) { tabs.prev(); doRender(); return }

	// Enter: submit
	if (k.key === 'enter' && !k.alt && !k.ctrl && !k.cmd) {
		const text = prompt.text().trim()
		prompt.reset()
		if (text) {
			const tab = tabs.active()
			const spamMatch = text.match(/^spa(m+)$/)
			if (spamMatch) {
				const count = spamMatch[1].length * 30
				for (let i = 0; i < count; i++)
					tab.lines.push(`[tab ${tab.id}] line ${tab.lines.length}: LOTS OF TEXT BLAH BLAH`)
			} else {
				tabs.appendText(tab, `> ${text}\n`)
				const words = text.split(' ').length
				const response = `Message: "${text}"\n${text.length} chars, ${words} word${words === 1 ? '' : 's'}\n`
				simulateResponse(tab, response)
			}
		}
		doRender()
		return
	}

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
