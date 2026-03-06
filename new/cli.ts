// Terminal client — reference implementation.

import { render, emptyState, type RenderState, type CursorPos } from './cli-render.ts'
import { parseKey } from './cli-keys.ts'
import * as tabs from './cli-tabs.ts'
import * as prompt from './cli-prompt.ts'
import { renderBlocks, type Block } from './cli-blocks.ts'

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
	const w = cols()
	const cw = contentWidth()

	// Content from blocks
	const contentLines = renderBlocks(tab.blocks, cw, halCursorVisible)

	// Pad to fill screen (stable layout)
	const pLines = prompt.lineCount(cw)
	const chromeLines = 3 + pLines
	const available = Math.max(0, (stdout.rows || 24) - chromeLines)
	const lines = [...contentLines]
	while (lines.length < available) lines.push('')

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
	// Add thinking block
	const thinkingBlock: Block = { type: 'thinking', text: '', done: false }
	tab.blocks.push(thinkingBlock)
	const thinkingText = 'Let me think about this...\n\nAnalyzing the input...'

	// Add assistant block (will start after thinking)
	const assistantBlock: Block = { type: 'assistant', text: '', done: false }

	let phase: 'thinking' | 'assistant' = 'thinking'
	let i = 0
	let j = 0
	const tick = setInterval(() => {
		if (phase === 'thinking') {
			if (i >= thinkingText.length) {
				thinkingBlock.done = true
				tab.blocks.push(assistantBlock)
				phase = 'assistant'
			} else {
				thinkingBlock.text += thinkingText[i]
				i++
			}
		} else {
			if (j >= text.length) {
				assistantBlock.done = true
				clearInterval(tick)
			} else {
				assistantBlock.text += text[j]
				j++
			}
		}
		doRender()
	}, 30)
}

function simulateToolCall(tab: ReturnType<typeof tabs.active>, name: string, cmd: string): void {
	const block: Block = {
		type: 'tool', name, status: 'running',
		args: cmd, output: '', startTime: Date.now(),
	}
	tab.blocks.push(block)

	// Simulate streaming output
	let line = 0
	const outputLines = [
		'drwxr-xr-x  5 user  staff  160 Mar  1 09:00 cache',
		'-rw-r--r--  1 user  staff  842 Mar  2 14:23 debug.log',
		'drwxr-xr-x  3 user  staff   96 Mar  3 11:45 sessions',
		'-rw-r--r--  1 user  staff  128 Mar  4 08:12 config.json',
		'-rw-r--r--  1 user  staff  256 Mar  5 16:30 auth.json',
		'drwxr-xr-x  8 user  staff  256 Mar  5 17:00 node_modules',
		'-rw-r--r--  1 user  staff  512 Mar  6 09:15 package.json',
		'-rw-r--r--  1 user  staff 1024 Mar  6 09:15 bun.lockb',
	]
	const tick = setInterval(() => {
		if (line >= outputLines.length) {
			block.status = 'done'
			clearInterval(tick)
		} else {
			block.output += (block.output ? '\n' : '') + outputLines[line]
			line++
		}
		doRender()
	}, 300)
}

const SPAM_TEXT = `The configuration system uses a layered approach where project-level settings override global defaults, and environment variables take highest priority over everything else in the chain.

Here's what we need to handle:

- **Token limits** need careful tracking across \`streaming\` and \`batch\` modes
- The \`**retry logic**\` should respect both rate limits and \`backoff\` timers
- Lists with **bold items** and \`code spans\` mixed together freely


When the context window fills up, compaction kicks in automatically. It summarizes older messages while preserving the most recent exchanges, tool results, and any pinned context the user marked as important.

## Implementation notes

1. **First pass**: scan all blocks for token counts using \`tiktoken\` estimation
2. **Second pass**: merge adjacent assistant blocks that share the same \`role\`
3. Run the \`**compaction prompt**\` against the oldest N messages
4. Replace originals with the summary, preserving \`tool_call\` and \`tool_result\` pairs

The streaming renderer operates on a simple principle — each block knows how to render itself into terminal lines, and the container joins them with consistent spacing. This avoids the classic problem where different parts of the UI fight over whitespace.


Error handling follows a similar pattern. Rather than wrapping everything in try-catch blocks scattered throughout the codebase, we use a central error boundary that catches unhandled rejections and formats them into error blocks visible in the conversation stream.`

function simulateSpam(tab: ReturnType<typeof tabs.active>, lineTarget: number): void {
	const block: Block = { type: 'assistant', text: '', done: false }
	tab.blocks.push(block)

	// Build text by repeating/slicing the corpus to roughly hit the line target
	// ~80 chars per line, so target chars ≈ lineTarget * 80
	const targetChars = lineTarget * 80
	let corpus = ''
	while (corpus.length < targetChars) corpus += SPAM_TEXT + '\n\n'
	corpus = corpus.slice(0, targetChars)

	// Stream one line (~80 chars) every 100ms, cutting at random word/sentence/paragraph boundaries
	let pos = 0
	const tick = setInterval(() => {
		if (pos >= corpus.length) {
			block.done = true
			clearInterval(tick)
			doRender()
			return
		}
		// Chunk size: ~60-100 chars, vary it
		const chunkSize = 60 + Math.floor(Math.random() * 40)
		const end = Math.min(pos + chunkSize, corpus.length)
		block.text += corpus.slice(pos, end)
		pos = end
		doRender()
	}, 100)
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
			// Add user input block
			tab.blocks.push({ type: 'input', text })

			if (text.startsWith('tool ')) {
				const rest = text.slice(5)
				const name = rest.startsWith('read') ? 'read' : 'bash'
				const cmd = rest.replace(/^(bash|read)\s*/, '') || 'ls -la'
				simulateToolCall(tab, name, cmd)
			} else {
				const spamMatch = text.match(/^spa(m+)$/)
				const count = spamMatch ? spamMatch[1].length * 10 : 0
				if (count > 0) {
					simulateSpam(tab, count)
				} else {
					const words = text.split(' ').length
					const response = `Message: "${text}"\n${text.length} chars, ${words} word${words === 1 ? '' : 's'}\n`
					simulateResponse(tab, response)
				}
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
