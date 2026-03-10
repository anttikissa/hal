// Terminal client — wired to IPC via Client + Transport.

import { render, emptyState, type RenderState, type CursorPos } from './cli/diff-engine.ts'
import { parseKeys } from './cli/keys.ts'
import { handleInput, type InputContext } from './cli/keybindings.ts'
import * as prompt from './cli/prompt.ts'
import { renderBlocks, renderQuestion } from './cli/blocks.ts'
import { maxTabHeight } from './cli/heights.ts'
import { Client, type TabState } from './cli/client.ts'
import { LocalTransport } from './cli/transport.ts'
import { shutdown } from './main.ts'
import { getConfig } from './config.ts'
import { displayModel } from './models.ts'
import { renderTabline } from './cli/tabline.ts'
import * as colors from './cli/colors.ts'
import { visLen, clipVisual } from './utils/strings.ts'
import { isVisible, start } from './cli/cursor.ts'
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
export const client = new Client(transport, () => { doRender() })

// ── Renderer ──

const DIM = '\x1b[38;5;245m', RESET = '\x1b[0m', YELLOW = '\x1b[33m', RED = '\x1b[31m', GREEN = '\x1b[32m'
let renderState: RenderState = emptyState

function oneLine(s: string): string {
	return s.replace(/\s*\r?\n+\s*/g, ' ').replace(/\s+/g, ' ')
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

function fmtContextPlain(ctx?: { used: number; max: number; estimated?: boolean }): { text: string; pctColor: string } | null {
	if (!ctx || ctx.max <= 0) return null
	const pctNum = ctx.used / ctx.max
	const pct = `${ctx.estimated ? '~' : ''}${(pctNum * 100).toFixed(1)}%`
	const max = ctx.max >= 1000 ? `${Math.round(ctx.max / 1000)}k` : String(ctx.max)
	const pctColor = pctNum >= 0.70 ? RED : pctNum >= 0.50 ? YELLOW : GREEN
	return { text: `${pct}/${max}`, pctColor }
}

function buildSeparator(tab: TabState | null, w: number, scrollInfo?: string): string {
	const { fg: iFg } = colors.input
	const model = shortModel(tab?.info.model)
	const state = deriveState(tab)
	const role = hal.isHost ? 'host' : 'client'
	const ctxInfo = fmtContextPlain(tab?.context)

	const rightParts = [role]
	if (tab?.sessionId) rightParts.push(tab.sessionId)
	if (ctxInfo) rightParts.push(ctxInfo.text)
	if (scrollInfo) rightParts.push(scrollInfo)

	const prefix = '── '
	const label = `You › Hal (${model}, ${state})`
	const suffix = ` ${rightParts.join(' · ')} ──`
	const iw = w
	const maxLabel = Math.max(1, iw - prefix.length - suffix.length - 1)
	const shown = label.length > maxLabel ? label.slice(0, maxLabel) : label
	const lead = `${prefix}${shown} `
	const fill = '─'.repeat(Math.max(1, iw - lead.length - suffix.length))
	const inner = lead + fill + suffix

	// Apply context pct color inline if present
	let colored = `${iFg}${inner}`
	if (ctxInfo) {
		const pctSlash = ctxInfo.text
		const idx = colored.lastIndexOf(pctSlash)
		if (idx >= 0) {
			const pctOnly = pctSlash.split('/')[0]
			colored = colored.slice(0, idx) + ctxInfo.pctColor + pctOnly + iFg + '/' + pctSlash.split('/')[1] + colored.slice(idx + pctSlash.length)
		}
	}

	return `${colored}${RESET}`
}

function buildLines(): { lines: string[]; cursor: CursorPos } {
	const cState = client.getState()
	const tab = client.activeTab()
	const w = cols()
	const cw = contentWidth()

	const blocks = tab?.blocks ?? []
	const hasQ = prompt.hasQuestion()
	const { lines: contentLines, streamCursor } = renderBlocks(blocks, w, isVisible())

	const lines: string[] = []
	let qAnswerStartRow = -1
	let qPromptResult: ReturnType<typeof prompt.buildPrompt> | null = null

	if (hasQ) {
		// Strip trailing idle cursor lines (empty/█/empty) from content
		let trimmed = contentLines
		if (trimmed.length >= 3 && !streamCursor) {
			trimmed = trimmed.slice(0, -3)
		}
		lines.push(...trimmed)
		if (lines.length > 0) lines.push('')

		// Question block (tool-like box) — part of content area, above tab bar
		const qLabel = prompt.getQuestionLabel()!
		const qLines = renderQuestion(qLabel, w)
		lines.push(...qLines)

		// Answer input area
		qPromptResult = prompt.buildPrompt(cw)
		qAnswerStartRow = lines.length
		lines.push(...qPromptResult.lines)
		lines.push('') // spacing before tab bar
	} else {
		lines.push(...contentLines)
		// Pad to tallest tab's content height (keeps prompt position stable)
		const activeSessionId = tab?.sessionId ?? null
		const maxHeight = maxTabHeight(cState.tabs, activeSessionId, w, contentLines.length)
		const pLines = prompt.lineCount(cw)
		// tab bar(1) + help bar(1) + prompt sep(1) + prompt lines
		const chromeLines = 3 + pLines
		const available = Math.max(0, (stdout.rows || 24) - chromeLines)
		const padTarget = Math.min(maxHeight, available)
		while (lines.length < padTarget) lines.push('')
	}

	// Tab bar
	const tabs = cState.tabs
	const idx = cState.activeTabIndex
	const parts = tabs.map((t, i) => {
		const title = t.info.topic ?? t.info.workingDir?.split('/').pop() ?? 'tab'
		let indicator: string | undefined
		const last = t.blocks[t.blocks.length - 1]
		if (t.question) indicator = '?'
		else if (!t.busy && last?.type === 'info' && (last.text === '[paused]' || last.text.startsWith('[interrupted]')))
			indicator = '!'
		return {
			label: `${i + 1} ${title}`,
			busy: !!t.busy,
			active: i === idx,
			indicator,
		}
	})
	const tabBar = renderTabline(parts, w, isVisible())
	lines.push(tabBar)

	let cursorPos: CursorPos

	if (hasQ && qPromptResult) {
		// Below tab bar: grayed-out separator + frozen main prompt (not editable)
		lines.push(buildSeparator(tab, w))
		const frozen = prompt.frozenText() ?? ''
		const frozenLines = frozen.split('\n')
		const shown = frozenLines.slice(0, 3)
		if (shown.length === 0 || (shown.length === 1 && shown[0] === '')) {
			lines.push(`${DIM} ${RESET}`)
		} else {
			for (const l of shown) lines.push(`${DIM} ${l}${RESET}`)
		}
		// Cursor is in the answer prompt area above tab bar
		cursorPos = { row: qAnswerStartRow + qPromptResult.cursor.rowOffset, col: qPromptResult.cursor.col }
	} else {
		// Normal prompt
		const p = prompt.buildPrompt(cw)
		const pLines = prompt.lineCount(cw)
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
	const safeHelp = clipVisual(oneLine(help), w)
	const hPad = Math.max(0, w - safeHelp.length)
	const hLeft = Math.max(0, Math.floor(hPad / 2))
	const hRight = Math.max(0, hPad - hLeft)
	lines.push(`${DIM}${'─'.repeat(hLeft)}${safeHelp}${'─'.repeat(hRight)}${RESET}`)

	// During streaming, position terminal cursor at the inline █ cursor
	if (streamCursor) cursorPos = streamCursor
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
start(doRender)
doRender()
client.start().catch(err => {
	console.error('Client start failed:', err)
	process.exit(1)
})