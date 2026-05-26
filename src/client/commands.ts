import type { Command, CommandType } from '../protocol.ts'

type PendingTabAction = 'open' | 'fork' | 'resume' | false

function pendingTabActionForPrompt(text: string): PendingTabAction {
	const trimmed = text.trim()
	if (/^\/fork(?:\s|$)/.test(trimmed)) return 'fork'
	if (/^\/self(?:\s|$)/.test(trimmed)) return 'open'
	if (/^\/open(?:\s|$)/.test(trimmed)) return 'open'
	if (/^\/resume\s+\S/.test(trimmed)) return 'resume'
	return false
}

function makeCommand(type: CommandType, sessionId: string | undefined, text?: string, displayText?: string, delivery?: 'queue'): Command {
	switch (type) {
		case 'prompt':
			return { type, sessionId, text: text ?? '', displayText, delivery }
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
		case 'continue':
		case 'queue-next':
		case 'close':
		case 'abort':
		case 'reset':
		case 'compact':
			return { type, sessionId }
		case 'rebase-start':
			return { type, sessionId, requestId: text ?? '', clientPid: process.pid }
		case 'rebase-apply': {
			const requestId = displayText ?? ''
			const parsed = JSON.parse(text ?? '{}') as { todo?: string; edits?: Record<string, string> }
			return { type, sessionId, requestId, clientPid: process.pid, todo: parsed.todo ?? '', edits: parsed.edits ?? {} }
		}
		case 'rename':
			return { type, sessionId, name: text ?? '' }
		case 'spawn':
			throw new Error('spawn commands must be created explicitly')
		case 'tool-confirm':
			throw new Error('tool confirmations must be created explicitly')
	}
}

export const clientCommands = {
	pendingTabActionForPrompt,
	makeCommand,
}
