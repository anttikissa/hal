import { describe, test, expect } from 'bun:test'
import { replayToBlocks, replayConfig } from './replay.ts'
import type { Message } from './history.ts'
import { blob } from './blob.ts'

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

	test('suppresses /continue info when tab is already busy', async () => {
		const messages: Message[] = [
			{ role: 'user', content: 'hello', ts: '2026-01-01T00:00:00Z' },
		]
		const blocks = await replayToBlocks('test-session', messages, undefined, true)
		expect(blocks.every(b => b.type !== 'info' || !(b as any).text?.includes('/continue'))).toBe(true)
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

	test('reads tool blobs in parallel with a concurrency cap', async () => {
		const originalRead = blob.read
		const originalConcurrency = replayConfig.blobReadConcurrency
		let activeReads = 0
		let peakReads = 0
		replayConfig.blobReadConcurrency = 3
		blob.read = async () => {
			activeReads += 1
			peakReads = Math.max(peakReads, activeReads)
			await Bun.sleep(5)
			activeReads -= 1
			return {
				call: { input: '' },
				result: { content: 'ok', status: 'success' },
			}
		}
		try {
			const messages: Message[] = [{
				role: 'assistant',
				text: '',
				tools: Array.from({ length: 8 }, (_, idx) => ({
					name: 'bash',
					id: `tool-${idx}`,
					blobId: `blob-${idx}`,
				})),
				ts: '2026-01-01T00:00:00Z',
			} as Message]
			const blocks = await replayToBlocks('test-session', messages)
			expect(blocks.filter((block) => block.type === 'tool')).toHaveLength(8)
			expect(peakReads).toBe(3)
		} finally {
			blob.read = originalRead
			replayConfig.blobReadConcurrency = originalConcurrency
		}
	})

	test('replays user messages with array content (images)', async () => {
		const messages: Message[] = [
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'client - host bug: ' },
					{ type: 'image', blobId: '000uwp-0tg' },
					{ type: 'text', text: ' prompt is not printed to client' },
				],
				ts: '2026-01-01T00:00:00Z',
			} as any,
		]
		const blocks = await replayToBlocks('test-session', messages)
		const input = blocks.find(b => b.type === 'input') as any
		expect(input).toBeDefined()
		expect(input.text).toContain('client - host bug:')
		expect(input.text).toContain('prompt is not printed')
		expect(input.text).toContain('[image]')
	})
})
