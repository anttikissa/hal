// Terminal client — wired to IPC via Client + Transport.

import { diffEngine, type RenderState } from './diff-engine.ts'
import { keys } from './keys.ts'
import { keybindings, type InputContext } from './keybindings.ts'
import { prompt } from './prompt.ts'
import { Client } from '../client.ts'
import { LocalTransport } from './transport.ts'
import { terminal } from './terminal.ts'
import { startupTrace } from '../perf/startup-trace.ts'
import { cursor } from './cursor.ts'
import { render } from './render.ts'
import { restartLogic } from './restart-logic.ts'

// ── Terminal setup ──

const { stdin, stdout } = process
if (!stdin.isTTY) { console.error('Need a TTY'); process.exit(1) }
stdin.setRawMode(true)
stdin.setEncoding('utf8')
stdin.resume()

const kittyTerms = /^(kitty|ghostty|iTerm\.app)$/
const useKitty = kittyTerms.test(process.env.TERM_PROGRAM ?? '')
if (useKitty) stdout.write(terminal.KITTY_KBD_ON)
stdout.write(terminal.BRACKETED_PASTE_ON)

process.on('exit', () => {
	if (!restartLogic.isCleanExit()) stdout.write(`\x1b[${stdout.rows || 24}B\r\n`)
	stdout.write(terminal.TERM_RESET)
})

// ── Host info (mutable — updated on promotion) ──

const hal = (globalThis as any).__hal as {
	isHost: boolean
	hostPid: number | null
	startupEpochMs?: number | null
	startupReadyElapsedMs?: number | null
	startupHostRuntimeElapsedMs?: number | null
}

function markStartupReady(): void {
	if (typeof hal.startupReadyElapsedMs === 'number' && Number.isFinite(hal.startupReadyElapsedMs) && hal.startupReadyElapsedMs >= 0) return
	const epoch = hal.startupEpochMs
	if (typeof epoch !== 'number' || !Number.isFinite(epoch) || epoch <= 0) return
	hal.startupReadyElapsedMs = Math.max(0, Date.now() - epoch)
	startupTrace.markAt('cli-ready', hal.startupReadyElapsedMs, 'first frame visible + prompt ready')
}

// ── Client ──

const transport = new LocalTransport()
export const client = new Client(transport, () => { doRender() })

// ── Renderer ──

let renderState: RenderState = diffEngine.emptyState

export function showError(msg: string): void {
	const tab = client.activeTab()
	if (tab) tab.blocks.push({ type: 'info', text: `⚠ ${msg}` })
	doRender()
}

export function doRender(forceClear = false): void {
	const cState = client.getState()
	const tab = client.activeTab()
	const { lines, cursor: cursorPos } = render.buildLines(cState, tab, hal.isHost)
	const { buf, state } = diffEngine.render(lines, renderState, cursorPos, stdout.rows || 24, forceClear)
	renderState = state
	if (buf) stdout.write(buf)
}

export function redraw(): void {
	renderState = diffEngine.emptyState
	doRender(true)
}

prompt.setRenderCallback(doRender)

// ── Lifecycle ──

restartLogic.init({
	client,
	useKitty,
	getRenderState: () => renderState,
	resetAndRender: () => redraw(),
	doRender,
})

process.on('SIGCONT', () => { restartLogic.onSigcont() })

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
	contentWidth: render.contentWidth,
	quit: restartLogic.quit,
	restart: restartLogic.restart,
	suspend: restartLogic.suspend,
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
markStartupReady()
client.start().catch(err => {
	console.error('Client start failed:', err)
	process.exit(1)
})

export const cli = { contentWidth: render.contentWidth, showError, doRender, redraw, quit: restartLogic.quit, restart: restartLogic.restart, suspend: restartLogic.suspend }
