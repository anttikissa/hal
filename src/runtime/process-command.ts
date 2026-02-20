import { stat } from "fs/promises"
import { resolve } from "path"
import type { RuntimeCommand } from "../protocol.ts"
import { makeSessionId } from "../session.ts"
import { enqueueCommand } from "./command-scheduler.ts"
import { publishLine, publishCommandPhase } from "./event-publisher.ts"
import { dropQueuedCommands } from "./handle-command.ts"
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
	markSessionAsActive,
	sortedBusySessionIds,
	isSessionBusy,
	emitStatus,
	lastCommandAtBySource,
} from "./sessions.ts"

const RAPID_COMMAND_PAUSE_MS = 1500
const URGENT_PAUSE_PATTERNS = [
	/\bstop\b/i, /\bsto+p+\b/i, /\bno+\b/i, /\bdon't\b/i, /\bdont\b/i,
	/\bwait\b/i, /\bhold on\b/i, /\bcancel\b/i, /\babort\b/i,
	/\bnevermind\b/i, /\bnot that\b/i,
]

function sourceKey(source: RuntimeCommand["source"], sessionId: string | null): string {
	return `${source.kind}:${source.clientId}:${sessionId ?? "-"}`
}

function promptLooksLikeUrgentPause(text: string): boolean {
	return URGENT_PAUSE_PATTERNS.some((p) => p.test(text))
}

function resolveSessionId(command: RuntimeCommand): string | null {
	const explicit = typeof command.sessionId === "string" ? command.sessionId.trim() : ""
	if (explicit) return sanitizeSessionId(explicit)
	if (getActiveSessionId()) return getActiveSessionId()
	if (getRegistryActiveSessionId()) return getRegistryActiveSessionId()
	return getFirstSessionId()
}

async function normalizeCommandSession(command: RuntimeCommand): Promise<string | null> {
	// Pause: prefer currently busy session
	if (command.type === "pause") {
		const explicitRaw = typeof command.sessionId === "string" ? command.sessionId.trim() : ""
		const explicit = explicitRaw ? sanitizeSessionId(explicitRaw) : null
		if (explicit) { command.sessionId = explicit; return explicit }
		const busyIds = sortedBusySessionIds()
		const active = getActiveSessionId()
		const fallback =
			(active && busyIds.includes(active) ? active : null)
			?? busyIds[0]
			?? active
			?? getRegistryActiveSessionId()
			?? getFirstSessionId()
			?? null
		command.sessionId = fallback
		return fallback
	}

	if (command.type === "close") {
		const sessionId = resolveSessionId(command)
		command.sessionId = sessionId
		return sessionId
	}

	// cd: ensure session exists
	if (command.type === "cd") {
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
	await publishLine("[pause] generation paused", "warn", sessionId)
}

async function maybeAutoPause(command: RuntimeCommand): Promise<void> {
	const key = sourceKey(command.source, command.sessionId ?? null)
	const now = Date.now()
	const lastAt = lastCommandAtBySource.get(key) ?? null
	lastCommandAtBySource.set(key, now)

	const sessionId = command.sessionId ?? null
	if (!sessionId) return
	const runtime = getCachedSessionRuntime(sessionId)
	if (!runtime || !isSessionBusy(sessionId) || runtime.pausedByUser) return

	const reason =
		command.type === "prompt" && typeof command.text === "string" && promptLooksLikeUrgentPause(command.text)
			? "[pause] auto-pause: urgent stop phrase detected"
			: (lastAt !== null && (now - lastAt) <= RAPID_COMMAND_PAUSE_MS
				? `[pause] auto-pause: two commands within ${RAPID_COMMAND_PAUSE_MS}ms`
				: null)
	if (!reason) return
	await publishLine(reason, "warn", sessionId)
	await runPause(sessionId)
}

export async function processCommand(command: RuntimeCommand): Promise<void> {
	const sessionId = await normalizeCommandSession(command)
	if (sessionId) markSessionAsActive(sessionId)

	if (command.type === "pause") {
		await publishCommandPhase(command.id, "queued", undefined, sessionId ?? null)
		await publishCommandPhase(command.id, "started", undefined, sessionId ?? null)
		await runPause(sessionId)
		await publishCommandPhase(command.id, "done", undefined, sessionId ?? null)
		await emitStatus(true)
		return
	}

	await maybeAutoPause(command)

	if (command.type === "reset" && sessionId) {
		const dropped = await dropQueuedCommands("dropped by /reset", sessionId)
		if (dropped > 0) {
			await publishLine(`[queue] dropped ${dropped} queued command(s) due to /reset`, "warn", sessionId)
		}
	}

	if (!sessionId) {
		await publishCommandPhase(command.id, "failed", "no session available", null)
		return
	}

	enqueueCommand(sessionId, command)
	await publishCommandPhase(command.id, "queued", undefined, sessionId)
	await emitStatus(true)
}
