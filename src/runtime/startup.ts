// Startup orchestration — creates the Runtime, restores sessions, tails commands.

import { watch, type FSWatcher } from 'fs'
import { ensureBus, commands, getState } from '../ipc.ts'
import { events } from '../ipc.ts'
import { createSession, loadMeta } from '../session/session.ts'
import { loadApiMessages } from '../session/messages.ts'
import { contextWindowForModel } from './context.ts'
import { getLastUsage } from '../session/messages.ts'
import { getConfig } from '../config.ts'
import { HAL_DIR, LAUNCH_CWD } from '../state.ts'
import { Runtime, setRuntime } from './runtime.ts'
import { handleCommand } from './commands.ts'

export async function startRuntime(): Promise<Runtime> {
	await ensureBus()
	const cmdOffset = await commands.offset()
	await events.trim(500)

	const rt = new Runtime()
	setRuntime(rt)

	// Restore sessions from state.ason (preserves tab order across restarts)
	const prevState = getState()
	for (const id of prevState.sessions) {
		const meta = await loadMeta(id)
		if (meta) {
			rt.sessions.set(meta.id, meta)
			const modelId = (meta.model ?? getConfig().defaultModel).split('/').pop()!
			// Restore context: prefer persisted real counts, then last API usage, then estimate
			let ctx: { used: number; max: number; estimated?: boolean } | undefined
			if (meta.context) {
				ctx = meta.context
			} else {
				const usage = getLastUsage(meta.id)
				if (usage) {
					ctx = { used: usage.input, max: contextWindowForModel(modelId) }
				} else {
					const apiMsgs = await loadApiMessages(meta.id)
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
	let needsGreeting: string | null = null
	if (rt.sessions.size === 0) {
		const info = await createSession()
		rt.sessions.set(info.id, info)
		rt.activeSessionId = info.id
		needsGreeting = info.id
		rt.setFreshContext(info)
	}

	// Publish initial state (must come before greeting so client has the tab)
	await rt.publish()

	// Greet new session after publish so the client can receive the chunks
	if (needsGreeting) {
		await rt.greetSession(needsGreeting)
	}

	for (const [id] of rt.sessions) {
		await rt.resumeInterruptedSession(id)
	}

	// Tail from offset captured at startup (no race window)
	let stopped = false
	const cmdTail = commands.tail(cmdOffset)
	;(async () => {
		for await (const cmd of cmdTail.items) {
			if (stopped) break
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
