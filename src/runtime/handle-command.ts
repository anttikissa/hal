import { resolve, isAbsolute } from "path"
import type { RuntimeCommand } from "../protocol.ts"
import { clearSession, performHandoff, saveSession } from "../session.ts"
import { loadConfig, updateConfig, resolveModel, resolveCompactModel, providerForModel, modelAlias, modelIdForModel } from "../config.ts"
import { getProvider } from "../provider.ts"
import { drainQueuedCommands } from "./command-scheduler.ts"
import { publishLine, publishCommandPhase, publishPrompt } from "./event-publisher.ts"
import { processPrompt } from "./process-prompt.ts"
import {
	getOrLoadSessionRuntime,
	reloadSystemPromptForSession,
	getSessionWorkingDir,
	getSessionMeta,
	markSessionAsActive,
	persistRegistry,
	emitStatus,
	emitSessions,
	busySessions,
	previousWorkingDirBySession,
	getHalDir,
} from "./sessions.ts"

export async function dropQueuedCommands(reason: string, sessionId: string): Promise<number> {
	const dropped = drainQueuedCommands(sessionId)
	for (const cmd of dropped) {
		await publishCommandPhase(cmd.id, "failed", reason, sessionId)
	}
	return dropped.length
}

export async function handleCommand(command: RuntimeCommand, sessionId: string): Promise<void> {
	await publishCommandPhase(command.id, "started", undefined, sessionId)

	try {
		switch (command.type) {
			case "prompt":
				await publishPrompt(sessionId, command.text ?? "", command.source)
				await processPrompt(sessionId, command.text ?? "")
				break

			case "handoff":
				await runHandoff(sessionId, command.text)
				break

			case "reset":
				await runReset(sessionId)
				break

			case "model":
				await runModel(sessionId, command.text ?? "")
				break

			case "system":
				await runSystem(sessionId)
				break

			case "cd":
				await runCd(sessionId, command.text ?? "")
				break

			case "close":
				await runClose(sessionId)
				break

			case "restart":
				await saveSessionBeforeExit(sessionId)
				process.exit(100)

			default:
				await publishLine(`[command] unknown: ${command.type}`, "warn", sessionId)
		}
		await publishCommandPhase(command.id, "done", undefined, sessionId)
	} catch (e: any) {
		await publishLine(`[error] ${e.message || e}`, "error", sessionId)
		await publishCommandPhase(command.id, "failed", e.message, sessionId)
	}
}

async function runHandoff(sessionId: string, text?: string): Promise<void> {
	const runtime = await getOrLoadSessionRuntime(sessionId)
	if (runtime.messages.length === 0) {
		await publishLine("[handoff] nothing to hand off — session is empty", "warn", sessionId)
		return
	}

	await publishLine("[handoff] generating summary...", "status", sessionId)

	// Use compact model for handoff summary
	const config = loadConfig()
	const compactModel = resolveCompactModel(config.model)
	const provider = getProvider(providerForModel(compactModel))
	await provider.refreshAuth()

	const systemPrompt = `You are summarizing a coding session for handoff. Produce a concise markdown summary that captures:
1. What was being worked on (goals, context)
2. What was accomplished so far
3. Current state (what files were changed, what's working/broken)
4. What needs to be done next
5. Any important decisions or context the next session should know

Be specific about file paths, function names, and technical details. The summary should let a new session continue seamlessly.`

	const conversationText = runtime.messages.map((m: any) => {
		const role = m.role
		const content = typeof m.content === "string" ? m.content
			: Array.isArray(m.content) ? m.content.map((b: any) => {
				if (b.type === "text") return b.text
				if (b.type === "thinking") return `[thinking] ${b.thinking}`
				if (b.type === "tool_use") return `[tool: ${b.name}] ${JSON.stringify(b.input)}`
				if (b.type === "tool_result") return `[result] ${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}`
				return ""
			}).filter(Boolean).join("\n") : ""
		return `[${role}]\n${content}`
	}).join("\n\n---\n\n")

	const userMsg = text
		? `${text}\n\n---\n\nHere is the full conversation:\n\n${conversationText}`
		: `Summarize this coding session for handoff:\n\n${conversationText}`

	const { text: summary, error } = await provider.complete({
		model: modelIdForModel(compactModel),
		system: systemPrompt,
		userMessage: userMsg,
		maxTokens: 4000,
	})

	if (error) {
		await publishLine(`[handoff] failed: ${error}`, "error", sessionId)
		return
	}

	await performHandoff(sessionId, summary)
	await publishLine("[handoff] summary saved to handoff.md, session rotated to session-previous.ason", "status", sessionId)
	await publishLine("[handoff] new session started — handoff context loaded", "status", sessionId)

	// Clear runtime cache so next prompt loads fresh
	const { getSessionCache } = await import("./sessions.ts")
	getSessionCache().delete(sessionId)
}

async function runReset(sessionId: string): Promise<void> {
	// Pause if busy
	const runtime = await getOrLoadSessionRuntime(sessionId)
	if (busySessions.has(sessionId)) {
		runtime.pausedByUser = true
		runtime.activeAbort?.abort()
	}

	await clearSession(sessionId)
	const { getSessionCache } = await import("./sessions.ts")
	getSessionCache().delete(sessionId)

	const meta = getSessionMeta(sessionId)
	if (meta) {
		meta.messageCount = 0
		meta.updatedAt = new Date().toISOString()
		await persistRegistry()
	}

	await publishLine("[reset] session cleared", "status", sessionId)
	await emitSessions(true)
}

async function runModel(sessionId: string, text: string): Promise<void> {
	const name = text.trim()
	if (!name) {
		const config = loadConfig()
		await publishLine(`[model] current: ${config.model}`, "info", sessionId)
		return
	}

	const fullModel = resolveModel(name)
	const config = updateConfig({ model: fullModel })

	// Reload system prompt for new model
	const loaded = await reloadSystemPromptForSession(sessionId)
	const promptDesc = loaded.length > 0 ? `  prompt=${loaded.join(", ")}` : ""

	await publishLine(
		`[model] switched to ${fullModel}${promptDesc}`,
		"status", sessionId,
	)
}

async function runSystem(sessionId: string): Promise<void> {
	const runtime = await getOrLoadSessionRuntime(sessionId)
	const blocks = runtime.systemPrompt
	if (!blocks || blocks.length === 0) {
		await publishLine("[system] (no system prompt loaded)", "info", sessionId)
		return
	}
	const text = blocks.map((b: any) => b.text ?? "").join("\n---\n")
	const lines = text.split("\n")
	const preview = lines.slice(0, 40).join("\n")
	const suffix = lines.length > 40 ? `\n... (${lines.length - 40} more lines)` : ""
	await publishLine(`[system] ${blocks.length} block(s), ${runtime.systemBytes} bytes:\n${preview}${suffix}`, "info", sessionId)
}

function resolveCdPath(sessionId: string, input: string, baseDir: string): string {
	const trimmed = input.trim()
	const halDir = getHalDir()
	const home = process.env.HOME ? resolve(process.env.HOME) : null
	if (!trimmed || trimmed === ".hal") return halDir
	if (trimmed === "-") {
		const prev = previousWorkingDirBySession.get(sessionId)
		if (prev) return prev
	}
	if (trimmed === "~") return home ?? baseDir
	if (trimmed.startsWith("~/") && home) return resolve(home, trimmed.slice(2))
	if (isAbsolute(trimmed)) return resolve(trimmed)
	return resolve(baseDir, trimmed)
}

async function runCd(sessionId: string, text: string): Promise<void> {
	if (!text.trim()) {
		await publishLine(`[cd] ${getSessionWorkingDir(sessionId)}`, "info", sessionId)
		return
	}

	const previous = getSessionWorkingDir(sessionId)
	const next = resolveCdPath(sessionId, text, previous)

	const { existsSync, statSync } = await import("fs")
	if (!existsSync(next) || !statSync(next).isDirectory()) {
		await publishLine(`[cd] not a directory: ${next}`, "error", sessionId)
		return
	}

	if (previous !== next) previousWorkingDirBySession.set(sessionId, previous)

	const meta = getSessionMeta(sessionId)
	if (meta) {
		meta.workingDir = next
		meta.updatedAt = new Date().toISOString()
		await persistRegistry()
	}

	const loaded = await reloadSystemPromptForSession(sessionId)
	const promptDesc = loaded.length > 0 ? `  prompt=${loaded.join(", ")}` : ""
	const dirMsg = previous !== next ? `${previous} -> ${next}` : next
	await publishLine(`[cd] ${dirMsg}${promptDesc}`, "status", sessionId)
}

async function runClose(sessionId: string): Promise<void> {
	const runtime = await getOrLoadSessionRuntime(sessionId)
	if (busySessions.has(sessionId)) {
		runtime.pausedByUser = true
		runtime.activeAbort?.abort()
	}

	await saveSession(sessionId, runtime.messages, runtime.tokenTotals)
	const { getSessionCache, getRegistry, getActiveSessionId, setActiveSessionId } = await import("./sessions.ts")
	getSessionCache().delete(sessionId)
	previousWorkingDirBySession.delete(sessionId)

	const registry = getRegistry()
	registry.sessions = registry.sessions.filter(s => s.id !== sessionId)
	if (registry.activeSessionId === sessionId) {
		registry.activeSessionId = registry.sessions[0]?.id ?? null
	}
	if (getActiveSessionId() === sessionId) {
		setActiveSessionId(registry.sessions[0]?.id ?? null)
	}
	await persistRegistry()
	await publishLine(`[close] session ${sessionId} closed`, "status", null)
	await emitSessions(true)
}

async function saveSessionBeforeExit(sessionId: string): Promise<void> {
	const runtime = await getOrLoadSessionRuntime(sessionId)
	await saveSession(sessionId, runtime.messages, runtime.tokenTotals)
}
