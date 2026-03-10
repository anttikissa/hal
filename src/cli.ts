// Terminal client — wired to IPC via Client + Transport.

import { render, emptyState, type RenderState, type CursorPos } from './cli/diff-engine.ts'
import { parseKeys } from './cli/keys.ts'
import { handleInput, type InputContext } from './cli/keybindings.ts'
import * as prompt from './cli/prompt.ts'
import { renderBlocks } from './cli/blocks.ts'
import { maxTabHeight } from './cli/heights.ts'
import { Client, type TabState } from './cli/client.ts'
import { LocalTransport } from './cli/transport.ts'
import { shutdown } from './main.ts'
import { getConfig } from './config.ts'
import { displayModel } from './models.ts'
import { renderTabline } from './cli/tabline.ts'
// ── Terminal setup ──

const { stdin, stdout } = process
if (!stdin.isTTY) { console.error('Need a TTY'); process.exit(1) }
stdin.setRawMode(true)
stdin.setEncoding('utf8')
stdin.resume()

const KITTY_KBD_ON = '\x1b[>27u', KITTY_KBD_OFF = '\x1b[<u'
const BRACKETED_PASTE_ON = '\x1b[?2004h', BRACKETED_PASTE_OFF = '\x1b[?2004l'
const TERM_RESET = `${KITTY_KBD_OFF}${BRACKETED_PASTE_OFF}\x1b[?25h`
const kittyTerms = /^(kitty|ghostty|iTerm\.app)$/
const useKitty = kittyTerms.test(process.env.TERM_PROGRAM ?? '')
if (useKitty) stdout.write(KITTY_KBD_ON)
stdout.write(BRACKETED_PASTE_ON)

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

const DIM = '\x1b[38;5;245m', RESET = '\x1b[0m', YELLOW = '\x1b[33m', RED = '\x1b[31m', GREEN = '\x1b[32m'
let halCursorVisible = true
let blinkTimer: ReturnType<typeof setTimeout> | null = null
let renderState: RenderState = emptyState

function scheduleBlink(): void {
	if (blinkTimer) clearTimeout(blinkTimer)
	blinkTimer = setTimeout(() => {
		halCursorVisible = !halCursorVisible
		doRender()
		scheduleBlink()
	}, 530)
}

function oneLine(s: string): string {
	return s.replace(/\s*\r?\n+\s*/g, ' ').replace(/\s+/g, ' ')
}

function clipForWidth(s: string, max: number): string {
	if (max <= 0) return ''
	if (s.length <= max) return s
	if (max === 1) return '…'
	return s.slice(0, max - 1) + '…'
}

function bumpCursor(): void {
	halCursorVisible = true
	scheduleBlink()
}

function shortModel(model?: string): string {
	return displayModel(model || getConfig().defaultModel)
}

function deriveState(tab: TabState | null): string {
	if (!tab) return 'idle'
	if (tab.pausing) return 'pausing'
	if (!tab.busy) return 'idle'
	const last = tab.blocks[tab.blocks.length - 1]
	if (!last) return 'idle'
	if (last.type === 'thinking' && !last.done) return 'thinking'
	if (last.type === 'tool' && (last.status === 'running' || last.status === 'streaming')) return 'tool'
	return 'writing'
}

function fmtContext(ctx?: { used: number; max: number; estimated?: boolean }): string {
	if (!ctx || ctx.max <= 0) return ''
	const pctNum = ctx.used / ctx.max
	const pct = `${ctx.estimated ? '~' : ''}${(pctNum * 100).toFixed(1)}%`
	const max = ctx.max >= 1000 ? `${Math.round(ctx.max / 1000)}k` : String(ctx.max)
	const color = pctNum >= 0.70 ? RED : pctNum >= 0.50 ? YELLOW : GREEN
	return `${color}${pct}${DIM}/${max}`
}

function buildSeparator(tab: TabState | null, w: number, scrollInfo?: string): string {
	const model = shortModel(tab?.info.model)
	const state = deriveState(tab)
	const role = hal.isHost ? 'host' : 'client'
	const ctx = fmtContext(tab?.context)
	const rightParts = [role]
	if (tab?.sessionId) rightParts.push(tab.sessionId)
	if (ctx) rightParts.push(ctx)
	if (scrollInfo) rightParts.push(scrollInfo)
	const left = ` ${model} (${state}) `
	const right = oneLine(` ${rightParts.join(' · ')}`)
	const safeRight = clipForWidth(right, Math.max(1, w - left.length - 1))
	const fill = Math.max(1, w - left.length - safeRight.length)
	return `${DIM}${left}${'─'.repeat(fill)}${safeRight}${RESET}`
}

function buildLines(): { lines: string[]; cursor: CursorPos } {
	const cState = client.getState()
	const tab = client.activeTab()
	const w = cols()
	const cw = contentWidth()

	const blocks = tab?.blocks ?? []
	const contentLines = renderBlocks(blocks, w, halCursorVisible)
	// Pad to tallest tab's content height (keeps prompt position stable)
	const activeSessionId = tab?.sessionId ?? null
	const maxHeight = maxTabHeight(cState.tabs, activeSessionId, w, contentLines.length)
	const pLines = prompt.lineCount(cw)
	const frozen = prompt.frozenText()
	const frozenLines = frozen ? Math.min(frozen.split('\n').length, 3) : 0
	// tab bar(1) + help bar(1) + prompt sep(1) + prompt lines + question area if active
	const chromeLines = 3 + pLines + (prompt.hasQuestion() ? 1 + frozenLines + 1 : 0)
	const available = Math.max(0, (stdout.rows || 24) - chromeLines)
	const padTarget = Math.min(maxHeight, available)
	const lines = [...contentLines]
	while (lines.length < padTarget) lines.push('')

	// Tab bar
	const tabs = cState.tabs
	const idx = cState.activeTabIndex
	const parts = tabs.map((t, i) => {
		const title = t.info.topic ?? t.info.workingDir?.split('/').pop() ?? 'tab'
		return {
			label: `${i + 1} ${title}`,
			busy: !!t.busy,
			active: i === idx,
		}
	})
	const tabBar = renderTabline(parts, w)
	lines.push(clipForWidth(oneLine(tabBar), w))

	// Question area (when active, shown above the regular prompt)
	const hasQ = prompt.hasQuestion()
	let cursorPos: CursorPos

	if (hasQ) {
		const qLabel = prompt.getQuestionLabel()!
		const qLeft = ` ${qLabel} `
		const qFill = Math.max(0, w - qLeft.length)
		lines.push(`${DIM}${qLeft}${'─'.repeat(qFill)}${RESET}`)

		// Answer input (buf is the question answer in question mode)
		const p = prompt.buildPrompt(cw)
		const answerStartRow = lines.length
		lines.push(...p.lines)
		cursorPos = { row: answerStartRow + p.cursor.rowOffset, col: p.cursor.col }

		// Grayed-out main prompt
		lines.push(buildSeparator(tab, w))
		const frozen = prompt.frozenText()
		if (frozen) {
			for (const l of frozen.split('\n').slice(0, 3)) {
				lines.push(`${DIM} ${l}${RESET}`)
			}
		}
	} else {
		// Normal prompt
		const p = prompt.buildPrompt(cw)
		lines.push(buildSeparator(tab, w, p.scrollInfo))
		lines.push(...p.lines)
		cursorPos = {
			row: lines.length - pLines + p.cursor.rowOffset,
			col: p.cursor.col,
		}
	}

	// Help bar
	const statusText = tab?.busy ? ' busy' : ''
	const help = ` ctrl-t new │ ctrl-w close │ ctrl-n/p switch │ ctrl-c quit${statusText} `
	const safeHelp = clipForWidth(oneLine(help), w)
	const hPad = Math.max(0, w - safeHelp.length)
	const hLeft = Math.max(0, Math.floor(hPad / 2))
	const hRight = Math.max(0, hPad - hLeft)
	lines.push(`${DIM}${'─'.repeat(hLeft)}${safeHelp}${'─'.repeat(hRight)}${RESET}`)

	return { lines, cursor: cursorPos }
}

export function showError(msg: string): void {
	const tab = client.activeTab()
	if (tab) tab.blocks.push({ type: 'info', text: `⚠ ${msg}` })
	doRender()
}

export function doRender(): void {
	const { lines, cursor: cursorPos } = buildLines()
	const { buf, state } = render(lines, renderState, cursorPos, stdout.rows || 24)
	renderState = state
	if (buf) stdout.write(buf)
}
prompt.setRenderCallback(doRender)

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
	stdout.write(BRACKETED_PASTE_ON)
	renderState = emptyState
	doRender()
})

// ── Input context ──

function sendCmd(type: string, text?: string): void {
	client.send(type as any, text).catch((e: Error) => showError(`send ${type}: ${e.message}`))
}

export const inputCtx: InputContext = {
	send: sendCmd,
	activeTab: () => client.activeTab(),
	tabs: () => client.getState().tabs,
	activeTabIndex: () => client.getState().activeTabIndex,
	saveDraft: () => client.saveDraft(),
	onSubmit: () => client.onSubmit(),
	nextTab: () => client.nextTab(),
	prevTab: () => client.prevTab(),
	switchToTab: (i) => client.switchToTab(i),
	clearQuestion: () => client.clearQuestion(),
	markPausing: () => client.markPausing(),
	doRender,
	contentWidth,
	quit,
	restart,
	suspend,
}

// ── Input handling ──

stdin.on('data', (data: string) => {
	for (const k of parseKeys(data)) handleInput(k, inputCtx)
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