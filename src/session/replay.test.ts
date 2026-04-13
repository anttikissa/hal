import { expect, test } from 'bun:test'
import { replay } from './replay.ts'

test('input history includes persisted slash-command retries', () => {
	const history = replay.inputHistoryFromEntries([
		{ role: 'user', content: 'hello' },
		{ type: 'input_history', text: '/config models.defaultModel [' },
	])

	expect(history).toEqual(['hello', '/config models.defaultModel ['])
})
