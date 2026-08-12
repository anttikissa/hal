import type { Command, CommandType } from '../common/protocol.ts'

export type ClientCommandType = Exclude<CommandType, 'client-exit' | 'client-status' | 'compact' | 'focus' | 'reset' | 'spawn' | 'tool-confirm'>

type PendingTabAction = 'open' | 'fork' | 'resume' | false

function pendingTabActionForPrompt(text: string): PendingTabAction {
	const trimmed = text.trim()
	if (/^\/fork(?:\s|$)/.test(trimmed)) return 'fork'
	if (/^\/self(?:\s|$)/.test(trimmed)) return 'open'
	if (/^\/open(?:\s|$)/.test(trimmed)) return 'open'
	if (/^\/resume\s+\S/.test(trimmed)) return 'resume'
	return false
}

function makeCommand(type: ClientCommandType, sessionId: string | undefined, text?: string, displayText?: string, queue?: boolean): Command {
	switch (type) {
		case 'prompt':
			return { type, sessionId, text: text ?? '', displayText, queue }
		case 'prompt-amend':
			return { type, sessionId, text: text ?? '', displayText }
		case 'open':
			if (text?.startsWith('fork:')) return { type, sessionId, forkSessionId: text.slice(5) }
			if (text?.startsWith('after:')) return { type, sessionId, afterSessionId: text.slice(6) }
			return { type, sessionId }
		case 'resume':
			return text ? { type, sessionId, selector: text } : { type, sessionId }
		case 'move': {
			const position = parseInt(text ?? '', 10)
			return { type, sessionId, position: Number.isFinite(position) ? position : 0 }
		}
		case 'what':
			return { type, sessionId, target: text ?? '' }
		case 'continue':
		case 'run-next-from-queue':
		case 'pause-before-tools':
		case 'close':
		case 'abort':
			return text === undefined ? { type, sessionId } : { type, sessionId, abortText: text }
		case 'rebase-start':
			return { type, sessionId, requestId: text ?? '', clientPid: process.pid }
		case 'rebase-apply': {
			const requestId = displayText ?? ''
			const parsed = JSON.parse(text ?? '{}') as { todo?: string; edits?: Record<string, string> }
			return { type, sessionId, requestId, clientPid: process.pid, todo: parsed.todo ?? '', edits: parsed.edits ?? {} }
		}
	}
}

export const clientCommands = {
	pendingTabActionForPrompt,
	makeCommand,
}
