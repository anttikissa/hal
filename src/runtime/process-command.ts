import type { RuntimeCommand } from '../protocol.ts'
import { loadSessionInfo, makeSessionId } from '../session.ts'
import { sessionDir } from '../state.ts'
import { existsSync } from 'fs'
import {
	enqueueCommand,
	pauseSession,
	resumeSession,
	isSessionPaused,
	sessionQueueLength,
	sessionQueuedCommands,
	drainQueuedCommands as drainSchedulerQueue,
	removeQueuedByIndices,
	removeSessionQueue,
	concurrencyStatus,
	isSessionRunning,
	promoteLastPrompt,
} from './command-scheduler.ts'
import { publishLine, publishCommandPhase, publishPrompt } from './event-publisher.ts'
import { dropQueuedCommands, runClose, runFork, runSystem, runCd } from './handle-command.ts'

import {
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
	persistRegistry,
	getSessionMeta,
} from './sessions.ts'

/** Parse "3", "1,3", "2-5", "1,3-5" → 1-based indices, or null for empty/invalid */
function parseDropIndices(args: string): number[] | null {
	if (!args) return null
	const indices: number[] = []
	for (const part of args.split(',')) {
		const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/)
		if (range) {
			const a = parseInt(range[1], 10), b = parseInt(range[2], 10)
			for (let i = Math.min(a, b); i <= Math.max(a, b); i++) indices.push(i)
		} else {
			const n = parseInt(part.trim(), 10)
			if (isNaN(n)) return null
			indices.push(n)
		}
	}
	return indices.length > 0 ? indices : null
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max - 3) + '...' : s
}
function resolveSessionId(command: RuntimeCommand): string | null {
	const explicit = typeof command.sessionId === 'string' ? command.sessionId.trim() : ''
	if (explicit) return explicit
	if (getActiveSessionId()) return getActiveSessionId()
	if (getRegistryActiveSessionId()) return getRegistryActiveSessionId()
	return getFirstSessionId()
}

async function normalizeCommandSession(command: RuntimeCommand): Promise<string | null> {
	// Pause: prefer currently busy session
	if (command.type === 'pause') {
		const explicit = typeof command.sessionId === 'string' ? command.sessionId.trim() : ''
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

	// cd: session must already exist
	if (command.type === 'cd') {
		const sessionId = resolveSessionId(command)
		if (!sessionId || !hasSession(sessionId)) {
			await publishLine(`[cd] unknown session: ${sessionId ?? '(none)'}`, 'error', null)
			return null
		}
		markSessionAsActive(sessionId)
		command.sessionId = sessionId
		return sessionId
	}

	// Default: session must already exist
	const sessionId = resolveSessionId(command)
	if (!sessionId || !hasSession(sessionId)) {
		await publishLine(`[error] unknown session: ${sessionId ?? '(none)'}`, 'error', null)
		return null
	}
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
			`[pause] paused — ${queued} queued message(s). Enter to resume, /queue to inspect, /drop to clear.`,
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

	// Open: create or restore a session. Bypasses normalizeCommandSession.
	if (command.type === 'open') {
		await publishCommandPhase(command.id, 'queued', undefined, null)
		await publishCommandPhase(command.id, 'started', undefined, null)
		const workingDir = command.text?.trim() || getDefaultWorkingDir()
		const activeId = getActiveSessionId()
		let sessionId: string

		if (command.sessionId && existsSync(sessionDir(command.sessionId))) {
			// Restore: re-add existing session to registry
			sessionId = command.sessionId
			const saved = await loadSessionInfo(sessionId)
			const session = await ensureSession(sessionId, saved?.workingDir ?? workingDir, activeId ?? undefined)
			if (saved) {
				if (saved.topic) session.topic = saved.topic
				if (saved.model) session.model = saved.model
			}
		} else {
			// New session
			sessionId = await makeSessionId()
			await ensureSession(sessionId, workingDir, activeId ?? undefined)
		}
		markSessionAsActive(sessionId)
		await persistRegistry()
		await publishCommandPhase(command.id, 'done', undefined, sessionId)
		await emitStatus()
		return
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

	// Steer: abort current generation, promote last queued prompt, resume — silently
	if (command.type === 'steer') {
		await publishCommandPhase(command.id, 'queued', undefined, sessionId ?? null)
		await publishCommandPhase(command.id, 'started', undefined, sessionId ?? null)
		if (sessionId) {
			const runtime = getCachedSessionRuntime(sessionId)
			if (runtime) {
				runtime.activeAbort?.abort()
				runtime.pausedByUser = false
			}
			const promoted = promoteLastPrompt(sessionId)
			if (promoted) {
				await publishPrompt(sessionId, promoted.text ?? '', command.source, 'steering')
			}
			resumeSession(sessionId)
		}
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

	// Drop: clear queued commands (all, or specific by number)
	if (command.type === 'drop') {
		await publishCommandPhase(command.id, 'queued', undefined, sessionId ?? null)
		await publishCommandPhase(command.id, 'started', undefined, sessionId ?? null)
		if (sessionId) {
			const args = (command.text ?? '').trim()
			const indices = parseDropIndices(args)
			if (indices) {
				// Drop specific items (1-based in user-facing, 0-based internally)
				const dropped = removeQueuedByIndices(sessionId, indices.map(i => i - 1))
				for (const cmd of dropped) {
					await publishCommandPhase(cmd.id, 'failed', 'dropped by user', sessionId)
				}
				if (dropped.length > 0) {
					const labels = dropped.map(c => c.text ?? c.type)
					await publishLine(
						`[drop] removed ${dropped.length}: ${labels.map(l => truncate(l, 40)).join(', ')}`,
						'warn',
						sessionId,
					)
				} else {
					await publishLine('[drop] no matching items', 'meta', sessionId)
				}
			} else {
				// Drop all
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
			}
			// Unpause if queue is now empty
			if (sessionQueueLength(sessionId) === 0) {
				const runtime = getCachedSessionRuntime(sessionId)
				if (runtime) runtime.pausedByUser = false
				resumeSession(sessionId)
			}
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

	if (command.type === 'prompt') {
		await publishPrompt(sessionId, command.text ?? '', command.source)
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
