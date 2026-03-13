// Startup orchestration — creates the Runtime, restores sessions, tails commands.

import { watch, type FSWatcher } from 'fs'
import { ipc } from '../ipc.ts'
import { session } from '../session/session.ts'
import { history } from '../session/history.ts'
import { context } from './context.ts'
import { config } from '../config.ts'
import { HAL_DIR, LAUNCH_CWD } from '../state.ts'
import { Runtime, runtimeCore } from './runtime.ts'
import { handoffConfig, type RuntimeHandoffState, type RuntimeCommand } from '../protocol.ts'


function shouldContinueAfterHandoff(handoff: RuntimeHandoffState | null): boolean {
	if (!handoff || handoff.mode !== 'continue') return false
	const createdAt = Date.parse(handoff.createdAt)
	if (!Number.isFinite(createdAt)) return false
	return Date.now() - createdAt <= handoffConfig.continueWindowMs
}
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

async function continueSessionAfterHandoff(rt: Runtime, sessionId: string): Promise<void> {
	const info = rt.sessions.get(sessionId)
	if (!info) {
		rt.busySessionIds.delete(sessionId)
		return
	}
	const pendingTools = rt.pendingInterruptedTools.get(sessionId)
		?? history.detectInterruptedTools(await history.readHistory(sessionId))
	if (pendingTools.length > 0) {
		const toolBlobMap = new Map(pendingTools.map(t => [t.id, t.blobId]))
		const entries = []
		for (const t of pendingTools) {
			entries.push(await history.writeToolResultEntry(sessionId, t.id, '[interrupted — skipped]', toolBlobMap))
		}
		await history.appendHistory(sessionId, entries)
		rt.pendingInterruptedTools.delete(sessionId)
	}

	const model = info.model ?? config.getConfig().defaultModel
	await history.ensureModelEvent(sessionId, model)
	const apiMessages = await history.loadApiMessages(sessionId)
	if (!rt.hasPendingUserTurn(apiMessages)) {
		rt.busySessionIds.delete(sessionId)
		return
	}
	await rt.startGeneration(sessionId, info, apiMessages, 'continuing...')
}

export async function startRuntime(): Promise<Runtime> {
	await ipc.ensureBus()
	const cmdOffset = await ipc.commands.offset()
	await ipc.events.trim(500)

	const rt = new Runtime()
	runtimeCore.setRuntime(rt)

	// Restore sessions from state.ason (preserves tab order across restarts)
	const prevState = ipc.getState()
	const handoff = prevState.handoff ?? null
	const continueAfterHandoff = shouldContinueAfterHandoff(handoff)
	const handoffBusyIds = continueAfterHandoff
		? [...new Set((handoff?.busySessionIds?.length ? handoff.busySessionIds : prevState.busySessionIds) ?? [])]
		: []
	if (handoff) {
		ipc.updateState(s => { s.handoff = null })
	}
	for (const id of prevState.sessions) {
		const meta = await session.loadSessionInfo(id)
		if (meta) {
			rt.sessions.set(meta.id, meta)
			const modelId = (meta.model ?? config.getConfig().defaultModel).split('/').pop()!
			// Restore context: prefer persisted real counts, then last API usage, then estimate
			let ctx: { used: number; max: number; estimated?: boolean } | undefined
			if (meta.context) {
				ctx = meta.context
			} else {
				const usage = await history.getLastUsage(meta.id)
				if (usage) {
					ctx = { used: usage.input, max: context.contextWindowForModel(modelId) }
				} else {
					const apiMsgs = await history.loadApiMessages(meta.id)
					ctx = rt.estimateSessionContext(meta, apiMsgs)
				}
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

	for (const id of handoffBusyIds) {
		if (rt.sessions.has(id)) rt.busySessionIds.add(id)
	}

	await rt.publish()
	if (continueAfterHandoff) {
		for (const id of handoffBusyIds) {
			await continueSessionAfterHandoff(rt, id)
		}
		await rt.publish()
	}

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
