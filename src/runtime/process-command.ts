import { stat } from 'fs/promises'
import { resolve } from 'path'
import type { RuntimeCommand } from '../protocol.ts'
import { makeSessionId } from '../session.ts'
import {
	enqueueCommand,
	pauseSession,
	resumeSession,
	isSessionPaused,
	sessionQueueLength,
	sessionQueuedCommands,
	drainQueuedCommands as drainSchedulerQueue,
	removeSessionQueue,
	concurrencyStatus,
	isSessionRunning,
} from './command-scheduler.ts'
import { publishLine, publishCommandPhase, publishPrompt } from './event-publisher.ts'
import { dropQueuedCommands, runClose, runFork, runSystem, runCd } from './handle-command.ts'

import {
	sanitizeSessionId,
	getActiveSessionId,
	getRegistryActiveSessionId,
	getFirstSessionId,
	getSessionWorkingDir,
	getDefaultWorkingDir,
	hasSession,
	ensureSession,
	getOrLoadSessionRuntime,
	getCachedSessionRuntime,
	isSessionBusy,
	markSessionAsActive,
	sortedBusySessionIds,
	emitStatus,
} from './sessions.ts'

function resolveSessionId(command: RuntimeCommand): string | null {
	const explicit = typeof command.sessionId === 'string' ? command.sessionId.trim() : ''
	if (explicit) return sanitizeSessionId(explicit)
	if (getActiveSessionId()) return getActiveSessionId()
	if (getRegistryActiveSessionId()) return getRegistryActiveSessionId()
	return getFirstSessionId()
}

async function normalizeCommandSession(command: RuntimeCommand): Promise<string | null> {
	// Pause: prefer currently busy session
	if (command.type === 'pause') {
		const explicitRaw = typeof command.sessionId === 'string' ? command.sessionId.trim() : ''
		const explicit = explicitRaw ? sanitizeSessionId(explicitRaw) : null
		if (explicit) {
			command.sessionId = explicit
			return explicit
		}
		const busyIds = sortedBusySessionIds()
		const active = getActiveSessionId()
		const fallback =
			(active && busyIds.includes(active) ? active : null) ??
			busyIds[0] ??
			active ??
			getRegistryActiveSessionId() ??
			getFirstSessionId() ??
			null
		command.sessionId = fallback
		return fallback
	}

	if (command.type === 'close') {
		const sessionId = resolveSessionId(command)
		command.sessionId = sessionId
		return sessionId
	}

	// cd: ensure session exists
	if (command.type === 'cd') {
		let sessionId = resolveSessionId(command)
		if (!sessionId) sessionId = makeSessionId()
		const active = getActiveSessionId()
		const fallbackDir = active ? getSessionWorkingDir(active) : getDefaultWorkingDir()
		if (!hasSession(sessionId)) {
			const target = command.text?.trim()
			let initialDir = fallbackDir
			if (target) {
				const desired = resolve(fallbackDir, target)
				const s = await stat(desired).catch(() => null)
				if (s?.isDirectory()) initialDir = desired
			}
			await ensureSession(sessionId, initialDir)
		}
		markSessionAsActive(sessionId)
		command.sessionId = sessionId
		return sessionId
	}

	// Default: ensure session loaded
	let sessionId = resolveSessionId(command)
	if (!sessionId) sessionId = makeSessionId()
	const active = getActiveSessionId()
	const fallbackDir = active ? getSessionWorkingDir(active) : getDefaultWorkingDir()
	await ensureSession(sessionId, fallbackDir)
	await getOrLoadSessionRuntime(sessionId)
	markSessionAsActive(sessionId)
	command.sessionId = sessionId
	return sessionId
}

async function runPause(sessionId: string | null): Promise<void> {
	if (!sessionId) return
	const runtime = getCachedSessionRuntime(sessionId)
	if (!runtime) return
	runtime.pausedByUser = true
	runtime.activeAbort?.abort()
	pauseSession(sessionId)
	const queued = sessionQueueLength(sessionId)
	if (queued > 0) {
		await publishLine(
			`[pause] paused — ${queued} queued message(s). Enter to resume, /drop to clear.`,
			'warn',
			sessionId,
		)
	} else {
		await publishLine('[pause] generation paused', 'warn', sessionId)
	}
}

/** Guard against duplicate delivery from IPC tail (watcher + poll can race) */
const processedCommandIds = new Set<string>()

export async function processCommand(command: RuntimeCommand): Promise<void> {
	if (processedCommandIds.has(command.id)) return
	processedCommandIds.add(command.id)
	// Keep bounded — command IDs are ephemeral, no need to remember old ones
	if (processedCommandIds.size > 500) {
		const first = processedCommandIds.values().next().value
		if (first) processedCommandIds.delete(first)
	}

	const sessionId = await normalizeCommandSession(command)
	if (sessionId) markSessionAsActive(sessionId)

	if (command.type === 'pause') {
		await publishCommandPhase(command.id, 'queued', undefined, sessionId ?? null)
		await publishCommandPhase(command.id, 'started', undefined, sessionId ?? null)
		await runPause(sessionId)
		await publishCommandPhase(command.id, 'done', undefined, sessionId ?? null)
		await emitStatus()
		return
	}

	// Close: run immediately, bypassing the concurrency-limited scheduler.
	// Close is a session management op, not a model task — it must not wait
	// for other busy sessions to finish.
	if (command.type === 'close') {
		await publishCommandPhase(command.id, 'queued', undefined, sessionId ?? null)
		await publishCommandPhase(command.id, 'started', undefined, sessionId ?? null)
		if (sessionId) {
			// Drop any queued commands for this session first
			const dropped = drainSchedulerQueue(sessionId)
			for (const cmd of dropped) {
				await publishCommandPhase(cmd.id, 'failed', 'session closed', sessionId)
			}
			removeSessionQueue(sessionId)
			await runClose(sessionId)
		}
		await publishCommandPhase(command.id, 'done', undefined, sessionId ?? null)
		await emitStatus()
		return
	}


	// Resume: unfreeze queue, let scheduler continue
	if (command.type === 'resume') {
		await publishCommandPhase(command.id, 'queued', undefined, sessionId ?? null)
		await publishCommandPhase(command.id, 'started', undefined, sessionId ?? null)
		if (sessionId && isSessionPaused(sessionId)) {
			const runtime = getCachedSessionRuntime(sessionId)
			if (runtime) runtime.pausedByUser = false
			const queued = sessionQueueLength(sessionId)
			resumeSession(sessionId)
			if (queued > 0) {
				await publishLine(
					`[resume] processing ${queued} queued message(s)`,
					'meta',
					sessionId,
				)
			}
		}
		await publishCommandPhase(command.id, 'done', undefined, sessionId ?? null)
		await emitStatus()
		return
	}

	// Drop: clear queued commands
	if (command.type === 'drop') {
		await publishCommandPhase(command.id, 'queued', undefined, sessionId ?? null)
		await publishCommandPhase(command.id, 'started', undefined, sessionId ?? null)
		if (sessionId) {
			const dropped = drainSchedulerQueue(sessionId)
			for (const cmd of dropped) {
				await publishCommandPhase(cmd.id, 'failed', 'dropped by user', sessionId)
			}
			if (dropped.length > 0) {
				await publishLine(
					`[drop] cleared ${dropped.length} queued message(s)`,
					'warn',
					sessionId,
				)
			} else {
				await publishLine('[drop] queue is empty', 'meta', sessionId)
			}
			// Unpause since there's nothing to resume
			const runtime = getCachedSessionRuntime(sessionId)
			if (runtime) runtime.pausedByUser = false
			resumeSession(sessionId)
		}
		await publishCommandPhase(command.id, 'done', undefined, sessionId ?? null)
		await emitStatus()
		return
	}

	// Queue: show queued commands for this session
	if (command.type === 'queue') {
		await publishCommandPhase(command.id, 'queued', undefined, sessionId ?? null)
		await publishCommandPhase(command.id, 'started', undefined, sessionId ?? null)
		if (sessionId) {
			const queued = sessionQueuedCommands(sessionId)
			if (queued.length === 0) {
				await publishLine('[queue] empty', 'meta', sessionId)
			} else {
				await publishLine(`[queue] ${queued.length} message(s):`, 'meta', sessionId)
				for (let i = 0; i < queued.length; i++) {
					const text = queued[i].text ?? queued[i].type
					const preview = text.length > 80 ? text.slice(0, 77) + '...' : text
					await publishLine(`  ${i + 1}. ${preview}`, 'meta', sessionId)
				}
			}
		}
		await publishCommandPhase(command.id, 'done', undefined, sessionId ?? null)
		return
	}

	// Fork: run immediately (bypasses scheduler, like close)
	// Don't pause the original session — let it keep generating.
	// runtime.messages is consistent at any sync point (partial streaming
	// content isn't pushed until the response completes).
	if (command.type === 'fork') {
		await publishCommandPhase(command.id, 'queued', undefined, sessionId ?? null)
		await publishCommandPhase(command.id, 'started', undefined, sessionId ?? null)
		if (!sessionId) {
			await publishCommandPhase(command.id, 'failed', 'no session to fork', null)
			return
		}
		await runFork(sessionId, command)
		await publishCommandPhase(command.id, 'done', undefined, sessionId)
		return
	}

	// System: read-only display — bypass scheduler so it works while session is busy
	if (command.type === 'system') {
		await publishCommandPhase(command.id, 'queued', undefined, sessionId ?? null)
		await publishCommandPhase(command.id, 'started', undefined, sessionId ?? null)
		if (sessionId) await runSystem(sessionId)
		await publishCommandPhase(command.id, 'done', undefined, sessionId ?? null)
		return
	}

	// cd: metadata-only — bypass scheduler so tab name updates immediately
	if (command.type === 'cd') {
		await publishCommandPhase(command.id, 'queued', undefined, sessionId ?? null)
		await publishCommandPhase(command.id, 'started', undefined, sessionId ?? null)
		if (sessionId) await runCd(sessionId, command.text ?? '')
		await publishCommandPhase(command.id, 'done', undefined, sessionId ?? null)
		return
	}


	if (command.type === 'reset' && sessionId) {
		const dropped = await dropQueuedCommands('dropped by /reset', sessionId)
		if (dropped > 0) {
			await publishLine(
				`[queue] dropped ${dropped} queued command(s) due to /reset`,
				'warn',
				sessionId,
			)
		}
		// Reset always clears paused state
		const runtime = getCachedSessionRuntime(sessionId)
		if (runtime) runtime.pausedByUser = false
		resumeSession(sessionId)
	}

	if (!sessionId) {
		await publishCommandPhase(command.id, 'failed', 'no session available', null)
		return
	}

	// Echo prompt immediately — label it [queued] if submitted while model is busy
	if (command.type === 'prompt') {
		const text = command.text ?? ''
		if (isSessionBusy(sessionId)) {
			await publishPrompt(sessionId, `[queued] ${text}`, command.source)
		} else {
			await publishPrompt(sessionId, text, command.source)
		}
	}

	enqueueCommand(sessionId, command)
	await publishCommandPhase(command.id, 'queued', undefined, sessionId)

	// Notify if command is waiting on a global concurrency slot.
	// If this session is already running, the new command is just queued behind it
	// and does not need a free global slot right now.
	const { running, max } = concurrencyStatus()
	const runningOtherSessions = running - (isSessionRunning(sessionId) ? 1 : 0)
	if (runningOtherSessions >= max && !isSessionBusy(sessionId)) {
		await publishLine(
			`[queue] ${runningOtherSessions}/${max} other sessions busy — will run when a slot opens`,
			'meta',
			sessionId,
		)
	}

	// Auto-resume: sending a new prompt while paused means you're ready to continue
	if (command.type === 'prompt' && isSessionPaused(sessionId)) {
		const runtime = getCachedSessionRuntime(sessionId)
		if (runtime) runtime.pausedByUser = false
		resumeSession(sessionId)
	}

	// Note: don't emitStatus here — the scheduler callback emits status before and
	// after handleCommand. Emitting here would race with publishActivity inside
	// command handlers (e.g. handoff), causing the client to reset busy state.
}
