import { test, expect } from 'bun:test'
import { replayToBlocks } from './replay.ts'
import type { Message } from './messages.ts'

test('info messages are replayed as info blocks', async () => {
	const messages: Message[] = [
		{ role: 'user', content: 'hello', ts: '2025-01-01T00:00:00Z' },
		{ role: 'assistant', text: 'hi', ts: '2025-01-01T00:00:01Z' },
		{ type: 'info', text: 'Context window >66% full', ts: '2025-01-01T00:00:02Z' },
	]
	const blocks = await replayToBlocks('test-session', messages)
	expect(blocks).toEqual([
		{ type: 'input', text: 'hello', model: undefined },
		{ type: 'assistant', text: 'hi', done: true, model: undefined },
		{ type: 'info', text: 'Context window >66% full' },
	])
})

test('error info messages get ⚠ prefix on replay', async () => {
	const messages: Message[] = [
		{ type: 'info', text: 'Error: something broke', level: 'error', ts: '2025-01-01T00:00:00Z' },
	]
	const blocks = await replayToBlocks('test-session', messages)
	expect(blocks[0]).toEqual({ type: 'info', text: '⚠ Error: something broke' })
})

test('meta info messages are replayed normally', async () => {
	const messages: Message[] = [
		{ type: 'info', text: '[paused]', level: 'meta', ts: '2025-01-01T00:00:00Z' },
	]
	const blocks = await replayToBlocks('test-session', messages)
	expect(blocks[0]).toEqual({ type: 'info', text: '[paused]' })
})
