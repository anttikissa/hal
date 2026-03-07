// Terminal client — wired to IPC via Client + Transport.

import { render, emptyState, type RenderState, type CursorPos } from './cli/diff-engine.ts'
import { parseKey } from './cli/keys.ts'
import { handleInput } from './cli/input-handler.ts'
import * as prompt from './cli/prompt.ts'
import { renderBlocks } from './cli/blocks.ts'
import { Client } from './cli/client.ts'
import { LocalTransport } from './cli/transport.ts'
import { shutdown } from './main.ts'
// ── Terminal setup ──

const { stdin, stdout } = process
if (!stdin.isTTY) { console.error('Need a TTY'); process.exit(1) }
stdin.setRawMode(true)
stdin.setEncoding('utf8')
stdin.resume()

const KITTY_KBD_ON = '\x1b[>27u', KITTY_KBD_OFF = '\x1b[<u'
const TERM_RESET = `${KITTY_KBD_OFF}\x1b[?25h`
const kittyTerms = /^(kitty|ghostty|iTerm\.app)$/
const useKitty = kittyTerms.test(process.env.TERM_PROGRAM ?? '')
if (useKitty) stdout.write(KITTY_KBD_ON)

let cleanExit = false
process.on('exit', () => {
	if (!cleanExit) stdout.write(`\x1b[${stdout.rows || 24}B\r\n`)
	stdout.write(TERM_RESET)
})

function cols(): number { return stdout.columns || 80 }
export function contentWidth(): number { return cols() - 2 }

// ── Host info (mutable — updated on promotion) ──

const hal = (globalThis as any).__hal as { isHost: boolean; hostPid: number | null }

// ── Client ──

const transport = new LocalTransport()
export const client = new Client(transport, () => { bumpCursor(); doRender() })

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
	const cState = client.getState()
	const tab = client.activeTab()
	const w = cols()
	const cw = contentWidth()

	const blocks = tab?.blocks ?? []
	const contentLines = renderBlocks(blocks, w, halCursorVisible)
	contentHighWater = Math.max(contentHighWater, contentLines.length)

	const pLines = prompt.lineCount(cw)
	const chromeLines = 3 + pLines
	const available = Math.max(0, (stdout.rows || 24) - chromeLines)
	const padTarget = Math.min(contentHighWater, available)
	const lines = [...contentLines]
	while (lines.length < padTarget) lines.push('')

	// Tab bar
	const tabs = cState.tabs
	const idx = cState.activeTabIndex
	const parts = tabs.map((t, i) => {
		const label = ` ${t.info.topic ?? t.sessionId} `
		const busy = t.busy ? '*' : ''
		return i === idx ? `${BOLD}[${label}${busy}]${RESET}` : `${DIM} ${label}${busy} ${RESET}`
	})
	lines.push(`tabs: ${parts.join('')}`)

	// Prompt — separator with host/client role
	const p = prompt.buildPrompt(w, cw)
	const role = hal.isHost ? `host pid ${hal.hostPid}` : `client → pid ${hal.hostPid}`
	const rightParts: string[] = []
	if (p.scrollInfo) rightParts.push(p.scrollInfo)
	const left = ` ${role} `
	const right = rightParts.length > 0 ? ` ${rightParts.join(' ')} ` : ''
	const fill = Math.max(0, w - left.length - right.length)
	lines.push(`${DIM}${left}${'─'.repeat(fill)}${right}${RESET}`)
	lines.push(...p.lines)
	const cursorPos: CursorPos = {
		row: lines.length - pLines + p.cursor.rowOffset,
		col: p.cursor.col,
	}

	// Help bar
	const statusText = tab?.busy ? ' busy' : ''
	const help = ` ctrl-t new │ ctrl-w close │ ctrl-n/p switch │ ctrl-c quit${statusText} `
	const hPad = w - help.length
	const hLeft = Math.max(0, Math.floor(hPad / 2))
	const hRight = Math.max(0, hPad - hLeft)
	lines.push(`${DIM}${'─'.repeat(hLeft)}${help}${'─'.repeat(hRight)}${RESET}`)

	return { lines, cursor: cursorPos }
}

export function doRender(): void {
	const { lines, cursor: cursorPos } = buildLines()
	const { buf, state } = render(lines, renderState, cursorPos, stdout.rows || 24)
	renderState = state
	if (buf) stdout.write(buf)
}

export function resetContentHighWater(): void { contentHighWater = 0 }

// ── Quit / Restart / Suspend ──

export function quit(): void {
	cleanExit = true
	if (renderState.lines.length > 0) {
		const total = renderState.lines.length
		const helpBarRow = total - 1
		const delta = renderState.cursorRow - helpBarRow
		if (delta > 0) stdout.write(`\x1b[${delta}A`)
		else if (delta < 0) stdout.write(`\x1b[${-delta}B`)
		stdout.write('\r\x1b[J')
		if (!prompt.text()) stdout.write(`\x1b[2A\r\x1b[J`)
	}
	void shutdown()
}

export function restart(): void {
	// Intentionally does NOT call releaseHost() — the lock stays so no
	// client promotes during the brief restart gap. The restarted process
	// reclaims its own lock.
	cleanExit = true
	if (renderState.lines.length > 0) {
		const up = renderState.cursorRow
		if (up > 0) stdout.write(`\x1b[${up}A`)
		stdout.write('\r\x1b[J')
	}
	process.exit(100)
}

export function suspend(): void {
	suspended = true
	stdout.write(`${useKitty ? KITTY_KBD_OFF : ''}\x1b[?25h`)
	try { process.kill(0, 'SIGSTOP') } catch { process.kill(process.pid, 'SIGSTOP') }
}

let suspended = false

process.on('SIGCONT', () => {
	if (!suspended) return
	suspended = false
	stdin.setRawMode(false)
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
	if (k) handleInput(k)
})

stdout.on('resize', () => {
	renderState = emptyState
	doRender()
})

// Start
scheduleBlink()
doRender()
client.start().catch(err => {
	console.error('Client start failed:', err)
	process.exit(1)
})