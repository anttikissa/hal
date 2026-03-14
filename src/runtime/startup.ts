// Startup orchestration — creates the Runtime, restores sessions, tails commands.

import { watch, type FSWatcher } from 'fs'
import { ipc } from '../ipc.ts'
import { session, type SessionInfo } from '../session/session.ts'
import { history } from '../session/history.ts'
import { context } from './context.ts'
import { config } from '../config.ts'
import { HAL_DIR, LAUNCH_CWD } from '../state.ts'
import { Runtime, runtimeCore } from './runtime.ts'
import type { RuntimeCommand } from '../protocol.ts'
import { startupTrace } from '../perf/startup-trace.ts'

let _handleCommand: ((rt: Runtime, cmd: RuntimeCommand) => Promise<void>) | null = null
let _handleCommandPromise: Promise<((rt: Runtime, cmd: RuntimeCommand) => Promise<void>)> | null = null

async function getHandleCommand(): Promise<(rt: Runtime, cmd: RuntimeCommand) => Promise<void>> {
	if (_handleCommand) return _handleCommand
	if (!_handleCommandPromise) {
		_handleCommandPromise = import('./commands.ts').then(mod => {
			_handleCommand = mod.commandHandlers.handleCommand
			return mod.commandHandlers.handleCommand
		})
	}
	return _handleCommandPromise
}

export async function startRuntime(): Promise<Runtime> {
	await ipc.ensureBus()
	const cmdOffset = await ipc.commands.offset()
	startupTrace.mark('rt-ipc-ready')
	const rt = new Runtime()
	runtimeCore.setRuntime(rt)

	// Restore sessions from state.ason (preserves tab order across restarts)
	const prevState = ipc.getState()
	startupTrace.mark('rt-state-loaded', `${prevState.sessions.length} sessions`)
	if (prevState.handoff) ipc.updateState(s => { s.handoff = null })
	for (const id of prevState.sessions) {
		const meta = await session.loadSessionInfo(id)
		if (meta) {
			rt.sessions.set(meta.id, meta)
			const modelId = (meta.model ?? config.getConfig().defaultModel).split('/').pop()!
			// Restore context from persisted counts or last API usage.
			let ctx: { used: number; max: number; estimated?: boolean }
			if (meta.context) {
				ctx = meta.context
			} else {
				const usage = await history.getLastUsage(meta.id)
				ctx = usage
					? { used: usage.input, max: context.contextWindowForModel(modelId) }
					: { used: 0, max: context.contextWindowForModel(modelId), estimated: true }
			}
			rt.sessionContext.set(meta.id, ctx)
			meta.context = ctx
			if (!rt.activeSessionId) rt.activeSessionId = meta.id
		}
	}
	// Prefer the previously active session
	if (prevState.activeSessionId && rt.sessions.has(prevState.activeSessionId)) {
		rt.activeSessionId = prevState.activeSessionId
	}
	// If nothing restored, create a fresh session with greeting
	if (rt.sessions.size === 0) {
		const info = await session.createSession()
		rt.sessions.set(info.id, info)
		rt.activeSessionId = info.id
		rt.setFreshContext(info)
		await rt.greetSession(info.id)
	}
	startupTrace.mark('rt-sessions-restored', `${rt.sessions.size} sessions`)

	// Pre-mark sessions with pending user turns as busy before first publish
	const pendingSessions: { id: string; info: SessionInfo; apiMessages: any[] }[] = []
	for (const [id, info] of rt.sessions) {
		const model = info.model ?? config.getConfig().defaultModel
		await history.ensureModelEvent(id, model)
		const apiMessages = await history.loadApiMessages(id)
		if (rt.hasPendingUserTurn(apiMessages)) {
			rt.busySessionIds.add(id)
			pendingSessions.push({ id, info, apiMessages })
		}
	}
	startupTrace.mark('rt-pending-scan', `${pendingSessions.length} pending`)

	await rt.publish()
	startupTrace.mark('rt-published')

	// Start generation for pre-marked sessions (don't block startup)
	if (pendingSessions.length > 0) {
		void (async () => {
			for (const { id, info, apiMessages } of pendingSessions) {
				await rt.startGeneration(id, info, apiMessages, 'continuing...')
			}
		})()
	}
	startupTrace.mark('rt-startup-continue-done')

	// Tail from offset captured at startup (no race window)
	let stopped = false
	const cmdTail = ipc.commands.tail(cmdOffset)
	;(async () => {
		let handleCommand: ((rt: Runtime, cmd: RuntimeCommand) => Promise<void>) | null = null
		for await (const cmd of cmdTail.items) {
			if (stopped) break
			if (!handleCommand) handleCommand = await getHandleCommand()
			await handleCommand(rt, cmd)
		}
	})()
	startupTrace.mark('rt-tail-started')

	// Watch SYSTEM.md + AGENTS.md for changes → notify active session
	const watchers: FSWatcher[] = []
	let watchDebounce: ReturnType<typeof setTimeout> | null = null
	const changedNames = new Set<string>()
	const onPromptFileChange = (name: string) => {
		changedNames.add(name)
		if (watchDebounce) clearTimeout(watchDebounce)
		watchDebounce = setTimeout(async () => {
			const label = [...changedNames].join(', ')
			changedNames.clear()
			if (rt.activeSessionId) await rt.emitInfo(rt.activeSessionId, `[system] reloaded ${label} (file changed)`, 'meta')
		}, 150)
	}
	for (const [path, name] of [[`${HAL_DIR}/SYSTEM.md`, 'SYSTEM.md'], [`${LAUNCH_CWD}/AGENTS.md`, 'AGENTS.md']] as const) {
		try { watchers.push(watch(path, { persistent: false }, () => onPromptFileChange(name))) } catch {}
	}

	rt.stop = () => { stopped = true; cmdTail.cancel(); watchers.forEach(w => w.close()) }
	return rt
}

export const startup = { startRuntime }
