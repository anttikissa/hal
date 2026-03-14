// Quit, restart, suspend, and handoff logic.

import type { RenderState } from './diff-engine.ts'
import type { TabState } from '../client.ts'
import type { Client } from '../client.ts'
import { terminal } from './terminal.ts'
import { halStatus, shutdown } from '../main.ts'
import { ipc } from '../ipc.ts'
import { handoffConfig, type RuntimeHandoffState } from '../protocol.ts'
import { diffEngine } from './diff-engine.ts'
import { prompt } from './prompt.ts'

const { stdout, stdin } = process

export interface RestartDeps {
	client: Client
	useKitty: boolean
	getRenderState: () => RenderState
	resetAndRender: () => void
	doRender: () => void
}

let deps: RestartDeps

let cleanExit = false
let suspended = false
let pendingAction: 'quit' | 'restart' | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null

function init(d: RestartDeps): void { deps = d }

function isCleanExit(): boolean { return cleanExit }

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
	return deps.client.getState().tabs.filter(isActiveTab).map(t => t.sessionId)
}

function busySessionIds(): string[] {
	const rt = runtimeOrNull()
	if (rt) {
		// Exclude sessions being paused (abort requested) — they shouldn't auto-continue after restart
		return [...rt.busySessionIds].filter(id => {
			const ac = rt.abortControllers.get(id)
			return !ac || !ac.signal.aborted
		})
	}
	return deps.client.getState().tabs.filter(t => t.busy).map(t => t.sessionId)
}

function writeHandoff(reason: 'quit' | 'restart'): RuntimeHandoffState | null {
	if (!halStatus.isHost) return null
	const activeIds = activeSessionIds()
	if (activeIds.length === 0) {
		ipc.updateState(s => { s.handoff = null })
		return null
	}
	const busySet = new Set(busySessionIds())
	const busyIds = [...busySet]
	const handoff: RuntimeHandoffState = {
		mode: 'continue',
		reason,
		fromPid: process.pid,
		createdAt: new Date().toISOString(),
		activeSessionIds: activeIds,
		busySessionIds: busyIds,
	}
	ipc.updateState(s => { s.handoff = handoff })
	return handoff
}

function printHandoffMessage(handoff: RuntimeHandoffState | null): void {
	if (!handoff || handoff.mode !== 'continue') return
	if (handoff.reason === 'restart') {
		console.log('Restarting: this process will continue from here')
		return
	}
	const seconds = Math.ceil(handoffConfig.continueWindowMs / 1000)
	console.log(`If Hal starts within ${seconds}s, it will continue from here`)
}

function clearPendingAction(): void {
	pendingAction = null
	if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
}

function quit(): void {
	if (hasDestructiveTools() && pendingAction !== 'quit') {
		pendingAction = 'quit'
		if (pendingTimer) clearTimeout(pendingTimer)
		pendingTimer = setTimeout(clearPendingAction, 5000)
		const tab = deps.client.activeTab()
		if (tab) tab.blocks.push({ type: 'info', text: 'waiting for tool calls to finish; ctrl-c again to force' })
		deps.doRender()
		return
	}
	clearPendingAction()
	terminal.disableTerminalInput(stdout, stdin)
	cleanExit = true
	const rs = deps.getRenderState()
	if (rs.lines.length > 0) {
		const total = rs.lines.length
		const helpBarRow = total - 1
		const delta = rs.cursorRow - helpBarRow
		if (delta > 0) stdout.write(`\x1b[${delta}A`)
		else if (delta < 0) stdout.write(`\x1b[${-delta}B`)
		stdout.write('\r\x1b[J')
		if (!prompt.text()) stdout.write(`\x1b[2A\r\x1b[J`)
	}
	const handoff = writeHandoff('quit')
	printHandoffMessage(handoff)
	void shutdown()
}

async function restart(): Promise<void> {
	if (hasDestructiveTools() && pendingAction !== 'restart') {
		pendingAction = 'restart'
		if (pendingTimer) clearTimeout(pendingTimer)
		pendingTimer = setTimeout(clearPendingAction, 5000)
		const tab = deps.client.activeTab()
		if (tab) tab.blocks.push({ type: 'info', text: 'waiting for tool calls to finish; ctrl-r again to force' })
		deps.doRender()
		return
	}
	clearPendingAction()
	await deps.client.saveDraft()
	terminal.disableTerminalInput(stdout, stdin)
	cleanExit = true
	const rs = deps.getRenderState()
	if (rs.lines.length > 0) {
		const up = rs.cursorRow
		if (up > 0) stdout.write(`\x1b[${up}A`)
		stdout.write('\r\x1b[J')
	}
	const handoff = writeHandoff('restart')
	printHandoffMessage(handoff)
	process.exit(100)
}

function suspend(): void {
	suspended = true
	stdout.write(`${deps.useKitty ? terminal.KITTY_KBD_OFF : ''}\x1b[?25h`)
	try { process.kill(0, 'SIGSTOP') } catch { process.kill(process.pid, 'SIGSTOP') }
}

function onSigcont(): void {
	if (!suspended) return
	suspended = false
	stdin.setRawMode(false)
	stdin.setRawMode(true)
	stdin.setEncoding('utf8')
	stdin.resume()
	if (deps.useKitty) stdout.write(terminal.KITTY_KBD_ON)
	stdout.write(terminal.BRACKETED_PASTE_ON)
	deps.resetAndRender()
}

export const restartLogic = { init, isCleanExit, quit, restart, suspend, onSigcont }
