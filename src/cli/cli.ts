// Terminal client — wired to IPC via Client + Transport.

import { diffEngine, type RenderState, type CursorPos } from './diff-engine.ts'
import { keys } from './keys.ts'
import { keybindings, type InputContext } from './keybindings.ts'
import { prompt } from './prompt.ts'
import { blocks as blockViews, type Block } from './blocks.ts'
import { heights } from './heights.ts'
import { Client, type TabState } from '../client.ts'
import { LocalTransport } from './transport.ts'
import { shutdown } from '../main.ts'
import { config } from '../config.ts'
import { models } from '../models.ts'
import { tabline } from './tabline.ts'
import * as colors from './colors.ts'
import { strings } from '../utils/strings.ts'
import { cursor } from './cursor.ts'
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
let renderState: RenderState = diffEngine.emptyState

function oneLine(s: string): string {
	return s.replace(/\s*\r?\n+\s*/g, ' ').replace(/\s+/g, ' ')
}
function shortModel(model?: string): string {
	return models.displayModel(model || config.getConfig().defaultModel)
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

function minicursorColor(block: Block): string | undefined {
	if (block.type === 'tool' && (block.status === 'streaming' || block.status === 'running')) return colors.tool(block.name).fg
	if (block.type === 'thinking' && !block.done) return colors.thinking.fg
	return undefined
}
function buildLines(): { lines: string[]; cursor: CursorPos } {
	const cState = client.getState()
	const tab = client.activeTab()
	const w = cols()
	const cw = contentWidth()

	const blocks = tab?.blocks ?? []
	const hasQ = prompt.hasQuestion()
	const { lines: contentLines } = blockViews.renderBlocks(blocks, w, cursor.isVisible())

	const lines: string[] = []
	let qAnswerStartRow = -1
	let qPromptResult: ReturnType<typeof prompt.buildPrompt> | null = null

	if (hasQ) {
		// Strip trailing idle cursor lines (empty/█/empty) from content
		let trimmed = contentLines
		if (trimmed.length >= 3) {
			trimmed = trimmed.slice(0, -3)
		}
		lines.push(...trimmed)
		if (lines.length > 0) lines.push('')

		// Question block (tool-like box) — part of content area, above tab bar
		const qLabel = prompt.getQuestionLabel()!
		const qLines = blockViews.renderQuestion(qLabel, w)
		lines.push(...qLines)

		// Answer input area
		qPromptResult = prompt.buildPrompt(cw)
		qAnswerStartRow = lines.length
		lines.push(...qPromptResult.lines)
		lines.push('') // spacing after answer input
		// Help bar below answer input
		const qHelp = ' enter to submit '
		const qhPad = Math.max(0, w - strings.visLen(qHelp))
		const qhLeft = Math.floor(qhPad / 2)
		const qhRight = qhPad - qhLeft
		lines.push(`${DIM}${'─'.repeat(qhLeft)}${qHelp}${'─'.repeat(qhRight)}${RESET}`)
		// Pad to push tab bar + chrome to bottom of screen
		const frozenRaw = prompt.frozenText() ?? ''
		const frozenSplit = frozenRaw.split('\n').slice(0, 3)
		const frozenCount = (!frozenSplit.length || (frozenSplit.length === 1 && !frozenSplit[0])) ? 1 : frozenSplit.length
		// chrome below: tab bar(1) + separator(1) + frozen prompt + help bar(1)
		const chromeBelow = 1 + 1 + frozenCount + 1
		const padTarget = Math.max(0, (stdout.rows || 24) - chromeBelow)
		while (lines.length < padTarget) lines.push('')
	} else {
		lines.push(...contentLines)
		// Pad to tallest tab's content height (keeps prompt position stable)
		const activeSessionId = tab?.sessionId ?? null
		const maxHeight = heights.maxTabHeight(cState.tabs, activeSessionId, w, contentLines.length)
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
		if (t.question) indicator = `${colors.question.fg}?`
		else if (!t.busy && last?.type === 'error') indicator = `${colors.error.fg}✖`
		else if (!t.busy && last?.type === 'info' && (last.text === '[paused]' || last.text.startsWith('[interrupted]')))
			indicator = '!'
		const cc = t.busy && last ? minicursorColor(last) : undefined
		return {
			label: `${i + 1} ${title}`,
			busy: !!t.busy,
			active: i === idx,
			cursorColor: cc,
			indicator,
		}
	})
	const tabBar = tabline.renderTabline(parts, w, cursor.isVisible())
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
	const help = ` ctrl-t new │ ctrl-w close │ ctrl-n/p switch │ ctrl-l redraw │ ctrl-c quit${statusText} `
	const safeHelp = strings.clipVisual(oneLine(help), w)
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

export function doRender(forceClear = false): void {
	const { lines, cursor: cursorPos } = buildLines()
	const { buf, state } = diffEngine.render(lines, renderState, cursorPos, stdout.rows || 24, forceClear)
	renderState = state
	if (buf) stdout.write(buf)
}

export function redraw(): void {
	renderState = diffEngine.emptyState
	doRender(true)
}
prompt.setRenderCallback(doRender)

// ── Quit / Restart / Suspend ──

import { halStatus } from '../main.ts'
import { ipc } from '../ipc.ts'
import type { RuntimeHandoffState } from '../protocol.ts'

function runtimeOrNull(): any {
	if (!halStatus.isHost) return null
	try {
		const { getRuntime } = require('../runtime/runtime.ts') as typeof import('../runtime/runtime.ts')
		return getRuntime()
	} catch {
		return null
	}
}

function hasDestructiveTools(): boolean {
	const rt = runtimeOrNull()
	return !!rt && rt.activeDestructiveTools.size > 0
}

function isActiveTab(tab: TabState): boolean {
	if (tab.busy || tab.pausing || tab.question) return true
	const last = tab.blocks[tab.blocks.length - 1]
	return !!last && last.type === 'error'
}

function activeSessionIds(): string[] {
	return client.getState().tabs.filter(isActiveTab).map(t => t.sessionId)
}

function busySessionIds(): string[] {
	const rt = runtimeOrNull()
	if (rt) return [...rt.busySessionIds]
	return client.getState().tabs.filter(t => t.busy).map(t => t.sessionId)
}

function findOtherHalPids(): number[] {
	try {
		const result = Bun.spawnSync(['pgrep', '-f', 'bun src/main.ts'])
		const out = result.stdout.toString().trim()
		if (!out) return []
		return out.split('\n').map(Number).filter(p => p !== process.pid && !isNaN(p))
	} catch {
		return []
	}
}

function writeHandoff(reason: 'quit' | 'restart', otherClientPids: number[]): RuntimeHandoffState | null {
	if (!halStatus.isHost) return null
	const activeIds = activeSessionIds()
	if (activeIds.length === 0) {
		ipc.updateState(s => { s.handoff = null })
		return null
	}
	const busySet = new Set(busySessionIds())
	const busyIds = activeIds.filter(id => busySet.has(id))
	const mode = reason === 'restart' || otherClientPids.length > 0 ? 'continue' : 'suspend'
	const handoff: RuntimeHandoffState = {
		mode,
		reason,
		fromPid: process.pid,
		createdAt: new Date().toISOString(),
		activeSessionIds: activeIds,
		busySessionIds: busyIds,
	}
	ipc.updateState(s => { s.handoff = handoff })
	return handoff
}

function printHandoffMessage(handoff: RuntimeHandoffState | null, pids: number[]): void {
	if (!handoff || handoff.mode !== 'continue') return
	if (pids.length === 1) {
		console.log(`Client pid ${pids[0]} will continue from here`)
		return
	}
	if (pids.length > 1) {
		console.log(`One of these clients will continue from here: ${pids.map(pid => `pid ${pid}`).join(', ')}`)
		return
	}
	if (handoff.reason === 'restart') {
		console.log('Restarting: this process will continue from here')
	}
}

let pendingAction: 'quit' | 'restart' | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null

function clearPendingAction(): void {
	pendingAction = null
	if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
}

export function quit(): void {
	if (hasDestructiveTools() && pendingAction !== 'quit') {
		pendingAction = 'quit'
		if (pendingTimer) clearTimeout(pendingTimer)
		pendingTimer = setTimeout(clearPendingAction, 5000)
		const tab = client.activeTab()
		if (tab) tab.blocks.push({ type: 'info', text: 'waiting for tool calls to finish; ctrl-c again to force' })
		doRender()
		return
	}
	clearPendingAction()
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
	const handoffPids = findOtherHalPids()
	const handoff = writeHandoff('quit', handoffPids)
	printHandoffMessage(handoff, handoffPids)
	void shutdown()
}

export function restart(): void {
	if (hasDestructiveTools() && pendingAction !== 'restart') {
		pendingAction = 'restart'
		if (pendingTimer) clearTimeout(pendingTimer)
		pendingTimer = setTimeout(clearPendingAction, 5000)
		const tab = client.activeTab()
		if (tab) tab.blocks.push({ type: 'info', text: 'waiting for tool calls to finish; ctrl-r again to force' })
		doRender()
		return
	}
	clearPendingAction()
	// Intentionally does NOT call releaseHost(). We write handoff state first,
	// then exit so either a promoted client or the restarted process can resume.
	cleanExit = true
	if (renderState.lines.length > 0) {
		const up = renderState.cursorRow
		if (up > 0) stdout.write(`\x1b[${up}A`)
		stdout.write('\r\x1b[J')
	}
	const handoffPids = findOtherHalPids()
	const handoff = writeHandoff('restart', handoffPids)
	printHandoffMessage(handoff, handoffPids)
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
	renderState = diffEngine.emptyState
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
	redraw,
	contentWidth,
	quit,
	restart,
	suspend,
}

// ── Input handling ──

stdin.on('data', (data: string) => {
	for (const k of keys.parseKeys(data)) keybindings.handleInput(k, inputCtx)
})

stdout.on('resize', () => {
	renderState = diffEngine.emptyState
	doRender()
})

// Start
cursor.start(doRender)
doRender()
client.start().catch(err => {
	console.error('Client start failed:', err)
	process.exit(1)
})

export const cli = { contentWidth, showError, doRender, redraw, quit, restart, suspend }