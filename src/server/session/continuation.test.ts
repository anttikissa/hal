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


test('UI-only assistant output does not create a continuation action', () => {
	expect(action([
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }] },
		{ type: 'assistant', text: 'hi' },
		{ type: 'turn_end', status: 'completed' },
		{ type: 'error', text: 'assistant prefill rejected' },
		{ type: 'turn_end', status: 'failed' },
		{ type: 'assistant', text: '/what summary', visibility: 'ui', synthetic: true },
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


test('login retries only the unresolved 401 from the same provider', () => {
	const user: HistoryEntry = { type: 'user', parts: [{ type: 'text', text: 'try this' }] }
	const failed = (provider: string, httpStatus: number): HistoryEntry[] => [
		user,
		{ type: 'error', text: `${httpStatus} provider error` },
		{ type: 'turn_end', status: 'failed', provider, httpStatus },
	]

	expect(continuation.shouldRetryAfterLogin(failed('future-provider', 401), 'future-provider')).toBe(true)
	expect(continuation.shouldRetryAfterLogin(failed('future-provider', 401), 'other-provider')).toBe(false)
	expect(continuation.shouldRetryAfterLogin(failed('future-provider', 403), 'future-provider')).toBe(false)
	expect(continuation.shouldRetryAfterLogin(failed('future-provider', 429), 'future-provider')).toBe(false)
	expect(continuation.shouldRetryAfterLogin([
		...failed('future-provider', 401),
		{ type: 'assistant', text: 'recovered' },
		{ type: 'turn_end', status: 'completed' },
	], 'future-provider')).toBe(false)
})

test('prepares continuation messages for interrupted and failed turns', () => {
	const messages: any[] = [{ role: 'user', content: 'prompt' }, { role: 'assistant', content: 'partial' }]
	continuation.prepareMessages(messages, 'continue')
	expect(messages.at(-1)).toMatchObject({ role: 'user' })

	const userTail: any[] = [{ role: 'user', content: 'prompt' }]
	continuation.prepareMessages(userTail, 'continue')
	expect(userTail).toHaveLength(1)

	const retry: any[] = [{ role: 'user', content: 'prompt' }]
	continuation.prepareMessages(retry, 'retry')
	expect(retry.at(-1)).toMatchObject({ role: 'user' })
	expect(retry.at(-1).content).toContain('previous attempt failed')
})
