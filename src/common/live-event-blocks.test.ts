import { describe, expect, test } from 'bun:test'
import { liveEventBlocks, type LiveBlock, type LiveEvent } from './live-event-blocks.ts'

function project(events: LiveEvent[]): LiveBlock[] {
	let blocks: LiveBlock[] = []
	for (const event of events) blocks = liveEventBlocks.reduce(blocks, event).blocks
	return blocks
}

describe('live event block projection', () => {
	test('projects the same event sequence deterministically', () => {
		const events: LiveEvent[] = [
			{ id: 'event-1', type: 'stream-delta', sessionId: 'session-1', channel: 'assistant', text: 'hello ', createdAt: '2026-08-13T09:00:00.000Z' },
			{ id: 'event-2', type: 'info', sessionId: 'session-1', text: 'system.md was reloaded', createdAt: '2026-08-13T09:00:01.000Z' },
			{ id: 'event-3', type: 'stream-delta', sessionId: 'session-1', channel: 'assistant', text: 'world', createdAt: '2026-08-13T09:00:02.000Z' },
			{ id: 'event-4', type: 'response', sessionId: 'session-1', text: 'hello world', createdAt: '2026-08-13T09:00:03.000Z' },
		]

		const first = project(events)
		const second = project(events)

		expect(first).toEqual(second)
		expect(first).toMatchObject([
			{ type: 'assistant', text: 'hello ', id: 'event-1' },
			{ type: 'log', text: 'system.md was reloaded' },
			{ type: 'assistant', text: 'world', continue: 'event-1' },
		])
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
})
