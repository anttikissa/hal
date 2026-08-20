import { describe, expect, test } from 'bun:test'
import { liveEventBlocks, type LiveBlock, type LiveEvent } from './live-event-blocks.ts'

function project(events: LiveEvent[]): LiveBlock[] {
	let blocks: LiveBlock[] = []
	for (const event of events) blocks = liveEventBlocks.reduce(blocks, event).blocks
	return blocks
}

test('projects prompt events as user blocks', () => {
	const result = liveEventBlocks.reduce([], {
		type: 'prompt',
		sessionId: 'session-1',
		text: 'shown',
		actualText: 'expanded',
		source: 'inbox',
		sourceTab: 2,
		sourceName: 'Inbox sender',
		label: 'queued',
		createdAt: '2026-08-13T08:59:00.000Z',
	})
	expect(result.blocks).toEqual([{
		type: 'user',
		text: 'shown',
		actualText: 'expanded',
		source: 'inbox',
		sourceTab: 2,
		sourceName: 'Inbox sender',
		status: 'queued',
		ts: Date.parse('2026-08-13T08:59:00.000Z'),
	}])
})

describe('live event block projection', () => {
	test('projects the same event sequence deterministically', () => {
		const events: LiveEvent[] = [
			{ type: 'stream-delta', sessionId: 'session-1', channel: 'assistant', text: 'hello ', createdAt: '2026-08-13T09:00:00.000Z' },
			{ type: 'info', sessionId: 'session-1', text: 'system.md was reloaded', createdAt: '2026-08-13T09:00:01.000Z' },
			{ type: 'stream-delta', sessionId: 'session-1', channel: 'assistant', text: 'world', createdAt: '2026-08-13T09:00:02.000Z' },
		]

		const first = project(events)
		const second = project(events)

		expect(first).toEqual(second)
		expect(first).toEqual([
			{ type: 'assistant', text: 'hello ', ts: Date.parse('2026-08-13T09:00:00.000Z') },
			{ type: 'log', text: 'system.md was reloaded', ts: Date.parse('2026-08-13T09:00:01.000Z') },
			{ type: 'assistant', text: 'world', streaming: true, ts: Date.parse('2026-08-13T09:00:02.000Z') },
		])
	})


	test('projects non-streaming synthetic responses as assistant blocks', () => {
		const result = liveEventBlocks.reduce([], {
			type: 'response',
			text: 'notice',
			model: 'openai/gpt-5.6-sol',
			synthetic: true,
			sessionId: 'session-1',
			createdAt: '2026-08-13T09:00:00.000Z',
		})

		expect(result.blocks).toEqual([{
			type: 'assistant',
			text: 'notice',
			model: 'openai/gpt-5.6-sol',
			synthetic: true,
			sessionId: 'session-1',
			ts: Date.parse('2026-08-13T09:00:00.000Z'),
		}])
	})

	test('returns a new projection without mutating its input', () => {
		const initial: LiveBlock[] = [{ type: 'assistant', text: 'hel', streaming: true }]
		const result = liveEventBlocks.reduce(initial, {
			type: 'stream-delta',
			channel: 'assistant',
			text: 'lo',
			model: 'openai/gpt-5.6-sol',
		})

		expect(initial).toEqual([{ type: 'assistant', text: 'hel', streaming: true }])
		expect(result.blocks).not.toBe(initial)
		expect(result.blocks).toEqual([{ type: 'assistant', text: 'hello', model: 'openai/gpt-5.6-sol', streaming: true }])
		expect(result.changed).toBe(true)
	})

	test('returns the updated tool block for client-side hydration', () => {
		const initial: LiveBlock[] = [{ type: 'tool', name: 'edit', toolId: 'tool-1', running: true }]
		const result = liveEventBlocks.reduce(initial, {
			type: 'tool-result',
			toolId: 'tool-1',
			output: 'done',
			phase: 'done',
		})

		expect(initial).toEqual([{ type: 'tool', name: 'edit', toolId: 'tool-1', running: true }])
		expect(result.toolBlock).toEqual({ type: 'tool', name: 'edit', toolId: 'tool-1', output: 'done' })
		expect(result.blocks[0]).toBe(result.toolBlock)
	})


	test('finishes running tools when their stream ends', () => {
		const result = liveEventBlocks.reduce([{ type: 'tool', name: 'web_search', toolId: 'search-1', running: true }], { type: 'stream-end' })

		expect(result.blocks).toEqual([{ type: 'tool', name: 'web_search', toolId: 'search-1' }])
	})
})
