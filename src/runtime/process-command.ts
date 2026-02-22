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
} from './command-scheduler.ts'
import { publishLine, publishCommandPhase, publishPrompt } from './event-publisher.ts'
import { dropQueuedCommands, runClose } from './handle-command.ts'
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

export async function processCommand(command: RuntimeCommand): Promise<void> {
	const sessionId = await normalizeCommandSession(command)
	if (sessionId) markSessionAsActive(sessionId)

	if (command.type === 'pause') {
		await publishCommandPhase(command.id, 'queued', undefined, sessionId ?? null)
		await publishCommandPhase(command.id, 'started', undefined, sessionId ?? null)
		await runPause(sessionId)
		await publishCommandPhase(command.id, 'done', undefined, sessionId ?? null)
		await emitStatus(true)
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
		await emitStatus(true)
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
					'status',
					sessionId,
				)
			}
		}
		await publishCommandPhase(command.id, 'done', undefined, sessionId ?? null)
		await emitStatus(true)
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
				await publishLine('[drop] queue is empty', 'status', sessionId)
			}
			// Unpause since there's nothing to resume
			const runtime = getCachedSessionRuntime(sessionId)
			if (runtime) runtime.pausedByUser = false
			resumeSession(sessionId)
		}
		await publishCommandPhase(command.id, 'done', undefined, sessionId ?? null)
		await emitStatus(true)
		return
	}

	// Queue: show queued commands for this session
	if (command.type === 'queue') {
		await publishCommandPhase(command.id, 'queued', undefined, sessionId ?? null)
		await publishCommandPhase(command.id, 'started', undefined, sessionId ?? null)
		if (sessionId) {
			const queued = sessionQueuedCommands(sessionId)
			if (queued.length === 0) {
				await publishLine('[queue] empty', 'status', sessionId)
			} else {
				await publishLine(`[queue] ${queued.length} message(s):`, 'status', sessionId)
				for (let i = 0; i < queued.length; i++) {
					const text = queued[i].text ?? queued[i].type
					const preview = text.length > 80 ? text.slice(0, 77) + '...' : text
					await publishLine(`  ${i + 1}. ${preview}`, 'status', sessionId)
				}
			}
		}
		await publishCommandPhase(command.id, 'done', undefined, sessionId ?? null)
		return
	}

	// Fork: auto-pause if busy, then enqueue (runs after agent loop stops)
	if (command.type === 'fork') {
		if (!sessionId) {
			await publishCommandPhase(command.id, 'queued', undefined, null)
			await publishCommandPhase(command.id, 'failed', 'no session to fork', null)
			return
		}
		if (isSessionBusy(sessionId)) {
			await runPause(sessionId)
			await publishLine('[fork] paused — forking after current task finishes', 'status', sessionId)
		}
		// Fall through to enqueue — scheduler runs it after current command
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

	// Echo prompt immediately — label it [steering] if submitted while model is busy
	if (command.type === 'prompt') {
		const text = command.text ?? ''
		if (isSessionBusy(sessionId)) {
			await publishPrompt(sessionId, `[steering] ${text}`, command.source)
		} else {
			await publishPrompt(sessionId, text, command.source)
		}
	}

	enqueueCommand(sessionId, command)
	await publishCommandPhase(command.id, 'queued', undefined, sessionId)

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
