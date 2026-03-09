import { describe, test, expect } from 'bun:test'
import { replayToBlocks } from './replay.ts'
import type { Message } from './messages.ts'

describe('replayToBlocks', () => {
	test('[system] prefix passes through as raw text', async () => {
		const messages: Message[] = [
			{ role: 'user', content: '[system] Session was reset. Previous log: messages.asonl', ts: '2026-01-01T00:00:00Z' },
		]
		const blocks = await replayToBlocks('test-session', messages)
		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toMatchObject({
			type: 'input',
			text: '[system] Session was reset. Previous log: messages.asonl',
		})
	})
})
