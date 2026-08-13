import { expect, test } from 'bun:test'
import type { ClientSessionSnapshot } from './snapshots.ts'
import { webMessages } from './web.ts'

const snapshot: ClientSessionSnapshot = {
	session: { id: '04-work', cwd: '/work', model: 'openai/gpt-5.6-sol' },
	history: [],
	live: [],
}

test('web event messages update live blocks through the shared projection', () => {
	const next = webMessages.applySessionMessage(snapshot, {
		type: 'event',
		event: { type: 'stream-delta', sessionId: '04-work', channel: 'assistant', text: 'Hello' },
	})
	expect(next).toEqual({
		...snapshot,
		live: [{ type: 'assistant', text: 'Hello', model: 'openai/gpt-5.6-sol', streaming: true }],
	})
	expect(snapshot.live).toEqual([])
})

test('web session projection ignores events for a different snapshot', () => {
	const next = webMessages.applySessionMessage(snapshot, {
		type: 'event',
		event: { type: 'stream-delta', sessionId: '04-other', channel: 'assistant', text: 'No' },
	})
	expect(next).toBe(snapshot)
})
