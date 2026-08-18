import { expect, test } from 'bun:test'
import type { HistoryEntry } from '../../common/history.ts'
import { continuation } from './continuation.ts'

function action(entries: HistoryEntry[]) {
	return continuation.actionForHistory(entries)
}

test('failed continue after a completed turn has no continuation action', () => {
	expect(action([
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }] },
		{ type: 'assistant', text: 'hi' },
		{ type: 'turn_end', status: 'completed' },
		{ type: 'error', text: 'assistant prefill rejected' },
		{ type: 'turn_end', status: 'failed' },
	])).toBe(false)
})

test('failed unfinished turn is retryable', () => {
	expect(action([
		{ type: 'turn_end', status: 'completed' },
		{ type: 'user', parts: [{ type: 'text', text: 'try this' }] },
		{ type: 'error', text: 'provider failed' },
		{ type: 'turn_end', status: 'failed' },
	])).toBe('retry')
})

test('aborted and unterminated turns are continuable', () => {
	const user: HistoryEntry = { type: 'user', parts: [{ type: 'text', text: 'keep going' }] }
	expect(action([user, { type: 'turn_end', status: 'aborted' }])).toBe('continue')
	expect(action([user, { type: 'error', text: 'Hit max iterations (50). Stopping.' }])).toBe('continue')
})

test('pending tools are continuable without visible turn content', () => {
	expect(action([{ type: 'pending_tools', toolIds: [], cwd: '/tmp' }])).toBe('continue')
})


test('bridges an assistant tail with a transient user message', () => {
	const messages: any[] = [{ role: 'user', content: 'prompt' }, { role: 'assistant', content: 'partial' }]
	continuation.bridgeAssistantTail(messages)
	expect(messages.at(-1)).toMatchObject({ role: 'user' })

	const userTail: any[] = [{ role: 'user', content: 'prompt' }]
	continuation.bridgeAssistantTail(userTail)
	expect(userTail).toHaveLength(1)
})
