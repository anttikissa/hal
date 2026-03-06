// Terminal client — reference implementation.

import { render, emptyState, enableLog, setPatchLines, type RenderState, type CursorPos } from './cli-diff-engine.ts'
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
const useKitty = kittyTerms.test(process.env.TERM_PROGRAM ?? '')
if (useKitty) stdout.write(KITTY_KBD_ON)

// On crash: move cursor below TUI so stacktrace doesn't overwrite content
let cleanExit = false
process.on('exit', () => {
	if (!cleanExit) stdout.write(`\x1b[${stdout.rows || 24}B\r\n`)
	stdout.write(TERM_RESET)
})

function cols(): number { return stdout.columns || 80 }
function contentWidth(): number { return cols() - 2 }

// ── Renderer ──

const DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m'
let halCursorVisible = true
let blinkTimer: ReturnType<typeof setTimeout> | null = null
let renderState: RenderState = emptyState
let contentHighWater = 0

function scheduleBlink(): void {
	if (blinkTimer) clearTimeout(blinkTimer)
	blinkTimer = setTimeout(() => {
		halCursorVisible = !halCursorVisible
		doRender()
		scheduleBlink()
	}, 530)
}

function bumpCursor(): void {
	halCursorVisible = true
	scheduleBlink()
}

function buildLines(): { lines: string[]; cursor: CursorPos } {
	const tab = tabs.active()
	const allTabs = tabs.all()
	const w = cols()
	const cw = contentWidth()

	// Content from blocks (full width; prompt uses cw for its own padding)
	const contentLines = renderBlocks(tab.blocks, w, halCursorVisible)
	contentHighWater = Math.max(contentHighWater, contentLines.length)

	// Pad to content high-water mark (grows with content, never full-screen on startup)
	const pLines = prompt.lineCount(cw)
	const chromeLines = 3 + pLines
	const available = Math.max(0, (stdout.rows || 24) - chromeLines)
	const padTarget = Math.min(contentHighWater, available)
	const lines = [...contentLines]
	while (lines.length < padTarget) lines.push('')

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
	const help = ' ctrl-t new │ ctrl-w close │ ctrl-n/p switch │ ctrl-z suspend │ ctrl-c quit '
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
	const assistantBlock: Block = { type: 'assistant', text: '', done: false, model: 'codex-5.3' }

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
		bumpCursor(); doRender()
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
		bumpCursor(); doRender()
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
	// Build corpus
	const targetChars = lineTarget * 80
	let corpus = ''
	while (corpus.length < targetChars) corpus += SPAM_TEXT + '\n\n'
	// Extend to next paragraph boundary
	const cut = corpus.indexOf('\n\n', targetChars)
	corpus = cut === -1 ? corpus : corpus.slice(0, cut)

	// Split into segments: always alternate thinking → assistant
	type Segment = { type: 'thinking' | 'assistant'; text: string; model?: string }
	const segments: Segment[] = []
	const paragraphs = corpus.split(/\n\n+/)
	let pi = 0
	while (pi < paragraphs.length) {
		// Thinking: 1 paragraph, strip markdown to look like internal reasoning
		const think = paragraphs[pi].replace(/[#*`\-\d.]/g, '').replace(/  +/g, ' ').trim()
		segments.push({ type: 'thinking', text: think || 'Let me think about this...' })
		pi++
		if (pi >= paragraphs.length) break
		// Assistant: 2-5 paragraphs (bulk of the content)
		const ac = Math.min(2 + Math.floor(Math.random() * 4), paragraphs.length - pi)
		segments.push({ type: 'assistant', text: paragraphs.slice(pi, pi + ac).join('\n\n'), model: 'codex-5.3' })
		pi += ac
	}

	// Stream segments sequentially
	let segIdx = 0
	let pos = 0
	let block: Block = { ...segments[0], text: '', done: false }
	tab.blocks.push(block)

	const tick = setInterval(() => {
		const seg = segments[segIdx]
		if (!seg) { clearInterval(tick); return }

		const chunkSize = 60 + Math.floor(Math.random() * 40)
		const end = Math.min(pos + chunkSize, seg.text.length)
		block.text += seg.text.slice(pos, end)
		pos = end

		if (pos >= seg.text.length) {
			block.done = true
			segIdx++
			pos = 0
			if (segIdx < segments.length) {
				block = { ...segments[segIdx], text: '', done: false }
				tab.blocks.push(block)
			}
		}
		bumpCursor(); doRender()
	}, 100)
}

// ── Quit / Close ──

function eraseTui(): void {
	cleanExit = true
	if (renderState.lines.length === 0) return
	const up = renderState.cursorRow
	if (up > 0) stdout.write(`\x1b[${up}A`)
	stdout.write('\r\x1b[J')
}

function quit(): void {
	cleanExit = true
	if (renderState.lines.length === 0) { process.exit(0) }
	// Keep blocks + tab bar + prompt text; erase only the help bar
	const total = renderState.lines.length
	const helpBarRow = total - 1
	const delta = renderState.cursorRow - helpBarRow
	if (delta > 0) stdout.write(`\x1b[${delta}A`)
	else if (delta < 0) stdout.write(`\x1b[${-delta}B`)
	stdout.write('\r\x1b[J')
	if (!prompt.text()) {
		stdout.write(`\x1b[2A\r\x1b[J`)
	}
	process.exit(0)
}

function closeTab(): void {
	if (!tabs.closeCurrent()) { quit(); return }
	prompt.reset()
	doRender()
}

let suspended = false

function suspend(): void {
	suspended = true
	stdout.write(`${useKitty ? KITTY_KBD_OFF : ''}\x1b[?25h`)
	try { process.kill(0, 'SIGSTOP') } catch { process.kill(process.pid, 'SIGSTOP') }
}

process.on('SIGCONT', () => {
	if (!suspended) return
	suspended = false
	stdin.setRawMode(false) // force tcsetattr re-apply
	stdin.setRawMode(true)
	stdin.setEncoding('utf8')
	stdin.resume()
	if (useKitty) stdout.write(KITTY_KBD_ON)
	renderState = emptyState
	doRender()
})

// ── Input handling ──

stdin.on('data', (data: string) => {
	const k = parseKey(data)
	if (!k) return

	if (k.key === 'k' && k.ctrl) { throw new Error('simulated crash (ctrl-k)') }
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
	if (k.key === 'z' && k.ctrl) { suspend(); return }
	if (k.key === 'r' && k.ctrl) {
		eraseTui()
		process.exit(100)
	}

	// Enter: submit
	if (k.key === 'enter' && !k.alt && !k.ctrl && !k.cmd) {
		const text = prompt.text().trim()
		prompt.reset()
		if (text) {
			const tab = tabs.active()
			// Add user input block
			tab.blocks.push({ type: 'input', text, model: 'codex-5.3' })

			if (text.startsWith('tool ')) {
				const rest = text.slice(5)
				const name = rest.startsWith('read') ? 'read' : 'bash'
				const cmd = rest.replace(/^(bash|read)\s*/, '') || 'ls -la'
				simulateToolCall(tab, name, cmd)
			} else if (text === 'help') {
				tab.blocks.push({ type: 'assistant', done: true, model: 'codex-5.3', text:
					`Commands:\n` +
					`  help              this message\n` +
					`  tool bash <cmd>   simulate a bash tool call\n` +
					`  tool read <path>  simulate a read tool call\n` +
					`  spam              10 lines of streaming text\n` +
					`  spamm             20 lines (more m's = more lines)\n` +
					`  <anything else>   echo response with thinking phase` })
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

enableLog()
if (process.env.PATCH || 1) setPatchLines(true)

tabs.active().blocks.push({ type: 'assistant', done: true, model: 'codex-5.3', text: `Say 'help' to see what I can do.` })
scheduleBlink()
doRender()
