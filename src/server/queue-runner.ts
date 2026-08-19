// Prompt queue UX — queueing prompts while a session works, the /queue
// slash command, and draining queued prompts after a turn completes.
// Storage lives in runtime/prompt-queue.ts; this module owns the behavior.

import { agentLoop, type AgentLoopResult } from './runtime/agent-loop.ts'
import { promptQueue, type QueuedPrompt } from './runtime/prompt-queue.ts'
import { sessions } from './sessions.ts'
import { transcriptTitles } from '../common/transcript-titles.ts'
// Circular import with runtime.ts is safe: we only access runtime.* at call time
// (module convention — all cross-module calls go through namespace objects).
import { runtime } from './runtime.ts'

function queuePreviewResult(text: string, max = 80): { text: string; truncated: boolean } {
	let first = text.split('\n')[0]!.trim()
	const truncated = text.includes('\n') || first.length > max
	if (first.length > max) first = first.slice(0, Math.max(0, max - 3)).trimEnd()
	return { text: truncated ? `${first}...` : first, truncated }
}

function queueNotice(text: string, source?: string, sourceTab?: number): string {
	if (!source || source === 'user') return `Prompt queued\n${text}`
	const sourceName = sessions.loadSessionMeta(source)?.name
	const sender = transcriptTitles.senderLabel(source, sourceTab, sourceName)
	return `Prompt queued from ${sender}\n${text}`
}

function queueEntry(text: string, source?: string, displayText?: string, sourceTab?: number): QueuedPrompt {
	return {
		text,
		createdAt: new Date().toISOString(),
		...(source ? { source } : {}),
		...(displayText ? { displayText } : {}),
		...(sourceTab ? { sourceTab } : {}),
	}
}

async function enqueuePrompt(sessionId: string, text: string, source?: string, displayText?: string, sourceTab?: number): Promise<void> {
	if (!text.trim()) return
	if (!agentLoop.isWorking(sessionId) && !promptQueue.isHeld(sessionId)) {
		await runtime.startPromptCommand(sessionId, text, source, displayText, undefined, sourceTab)
		return
	}
	promptQueue.append(sessionId, queueEntry(text, source, displayText, sourceTab))
	runtime.emitInfo(sessionId, queueNotice(text, source, sourceTab))
}

function buildQueuePausedNotice(entries: QueuedPrompt[]): string {
	const count = entries.length
	const noun = count === 1 ? 'prompt is' : 'prompts are'
	const preview = entries[0] ? queuePreviewResult(entries[0].text, 50) : undefined
	const next = preview ? ` Next: **${preview.text}**.` : ''
	const run = count === 1 ? 'run the queued prompt' : 'run queued prompts'
	const discard = count === 1 ? '`/queue clear` to discard it' : '`/queue clear` to discard'
	const show = preview?.truncated ? `, \`/queue\` to show ${count === 1 ? 'it' : 'them'}` : ''
	return `Paused. ${count} queued ${noun} waiting.${next} **ctrl-q** to ${run}${show}, ${discard}.`
}

function emitQueuePausedNotice(sessionId: string): void {
	const entries = promptQueue.load(sessionId)
	if (entries.length === 0) return
	promptQueue.setHeld(sessionId, true)
	runtime.emitInfo(sessionId, buildQueuePausedNotice(entries), 'info', 'notice')
}

function shouldDrainQueuedPrompt(sessionId: string, result: AgentLoopResult): boolean {
	return result === 'completed' && !sessions.findPendingTools(sessionId) && !promptQueue.isHeld(sessionId) && promptQueue.load(sessionId).length > 0
}

async function runNextQueuedPrompt(sessionId: string, quiet = true): Promise<boolean> {
	const next = promptQueue.pop(sessionId)
	if (!next) {
		if (!quiet) runtime.emitInfo(sessionId, 'Queue is empty')
		return false
	}
	promptQueue.setHeld(sessionId, false)
	await runtime.startPromptCommand(sessionId, next.text, next.source, next.displayText ?? next.text, undefined, next.sourceTab)
	return true
}

async function handleQueueSlashCommand(sessionId: string, text: string, source?: string, displayText?: string, working = false): Promise<boolean> {
	const match = text.trimStart().match(/^\/queue(?:\s+([\s\S]*))?$/)
	if (!match) return false
	const args = (match[1] ?? '').trim()
	if (!args) {
		const entries = promptQueue.load(sessionId)
		if (entries.length === 0) runtime.emitInfo(sessionId, 'Queue is empty')
		else for (let i = 0; i < entries.length; i++) runtime.emitInfo(sessionId, `${i + 1}. ${entries[i]!.text}`)
		return true
	}
	if (args === 'next') {
		if (working) runtime.emitInfo(sessionId, 'Session is working')
		else await queueRunner.runNextQueuedPrompt(sessionId, false)
		return true
	}
	if (args === 'clear') {
		promptQueue.clear(sessionId)
		runtime.emitInfo(sessionId, 'Queue cleared')
		return true
	}
	await queueRunner.enqueuePrompt(sessionId, args, source, displayText)
	return true
}

export const queueRunner = {
	enqueuePrompt,
	buildQueuePausedNotice,
	emitQueuePausedNotice,
	shouldDrainQueuedPrompt,
	runNextQueuedPrompt,
	handleQueueSlashCommand,
}
