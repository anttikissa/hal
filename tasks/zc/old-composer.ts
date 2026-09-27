import type { Command } from '../../common/protocol.ts'

type EnterAction = 'submit' | 'queue' | 'newline' | 'none'

// Desktop chat convention: Enter sends, Shift+Enter inserts a newline. On touch
// keyboards (coarse pointer) there is no Shift, so Enter inserts a newline and
// the Send button sends — the iMessage/WhatsApp pattern.
function enterAction(key: string, opts: { shift?: boolean; coarse?: boolean; meta?: boolean; ctrl?: boolean; working?: boolean }): EnterAction {
	if (key !== 'Enter') return 'none'
	if (opts.shift) return 'newline'
	if (opts.working && (opts.meta || opts.ctrl)) return 'queue'
	if (opts.coarse) return 'newline'
	return 'submit'
}

function typingKey(event: KeyboardEvent): boolean {
	return [...event.key].length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing
}

// While a turn runs, sending interrupts it — the terminal calls that steering.
// Naming the button for what it does keeps the queue button's purpose obvious.
function sendLabel(working: boolean): string {
	return working ? 'Steer' : 'Send'
}

// Include a separator only when the marker follows non-whitespace text.
function attachmentRef(value: string, start: number, path: string): string {
	return `${start > 0 && !/\s/.test(value[start - 1]!) ? ' ' : ''}[${path}] `
}

function pastedImage<T extends { type: string }>(items: Iterable<{ type: string; getAsFile: () => T | null }>): T | null {
	for (const item of items) {
		if (!item.type.startsWith('image/')) continue
		const file = item.getAsFile()
		if (file) return file
	}
	return null
}

// /what is a client command, not an agent prompt. Route it through the same
// non-interrupting protocol command as the terminal; other slash commands stay
// prompts so the server's command parser remains their source of truth.
function submissionCommand(text: string, sessionId: string, id: string, queue: boolean): Command {
	const what = /^\/what(?:\s+(.*))?$/s.exec(text.trim())
	if (what) return { type: 'what', sessionId, target: what[1]?.trim() ?? '' }
	return { type: 'prompt', id, sessionId, text, source: 'web', queue }
}

export { attachmentRef, enterAction, pastedImage, sendLabel, submissionCommand, typingKey }
export type { EnterAction }
