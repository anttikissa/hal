import { describe, test, expect } from 'bun:test'
import { replayToBlocks } from './replay.ts'
import type { Message } from './history.ts'

describe('replayToBlocks', () => {
	test('[system] prefix passes through as raw text', async () => {
		const messages: Message[] = [
			{ role: 'user', content: '[system] Session was reset. Previous log: history.asonl', ts: '2026-01-01T00:00:00Z' },
			{ role: 'assistant', text: 'ok', ts: '2026-01-01T00:00:01Z' },
		]
		const blocks = await replayToBlocks('test-session', messages)
		expect(blocks[0]).toMatchObject({
			type: 'input',
			text: '[system] Session was reset. Previous log: history.asonl',
		})
	})

	test('shows resume info when last message is from user (pending turn)', async () => {
		const messages: Message[] = [
			{ role: 'user', content: 'hello', ts: '2026-01-01T00:00:00Z' },
		]
		const blocks = await replayToBlocks('test-session', messages)
		const last = blocks[blocks.length - 1]
		expect(last).toMatchObject({ type: 'info', text: expect.stringContaining('/continue') })
	})

	test('shows resume info for interrupted tools', async () => {
		const messages: Message[] = [
			{ role: 'user', content: 'do something', ts: '2026-01-01T00:00:00Z' },
			{ role: 'assistant', text: '', tools: [{ name: 'bash', id: 'tool1', blobId: 'ref1' }], ts: '2026-01-01T00:00:01Z' },
		]
		const blocks = await replayToBlocks('test-session', messages)
		const last = blocks[blocks.length - 1] as any
		expect(last.type).toBe('info')
		expect(last.text).toContain('interrupted')
		expect(last.text).toContain('bash')
	})

	test('shows resume info when last message is tool_result (interrupted re-generation)', async () => {
		const messages: Message[] = [
			{ role: 'user', content: 'do something', ts: '2026-01-01T00:00:00Z' },
			{ role: 'assistant', text: '', tools: [{ name: 'bash', id: 'tool1', blobId: 'ref1' }], ts: '2026-01-01T00:00:01Z' },
			{ role: 'tool_result', tool_use_id: 'tool1', blobId: 'ref1', ts: '2026-01-01T00:00:02Z' },
		]
		const blocks = await replayToBlocks('test-session', messages)
		const last = blocks[blocks.length - 1]
		expect(last).toMatchObject({ type: 'info', text: expect.stringContaining('/continue') })
	})

	test('no resume info when conversation is complete', async () => {
		const messages: Message[] = [
			{ role: 'user', content: 'hello', ts: '2026-01-01T00:00:00Z' },
			{ role: 'assistant', text: 'hi there', ts: '2026-01-01T00:00:01Z' },
		]
		const blocks = await replayToBlocks('test-session', messages)
		expect(blocks.every(b => b.type !== 'info' || !(b as any).text?.includes('/continue'))).toBe(true)
	})

	test('no resume info on empty session', async () => {
		const messages: Message[] = []
		const blocks = await replayToBlocks('test-session', messages)
		expect(blocks).toHaveLength(0)
	})
})
