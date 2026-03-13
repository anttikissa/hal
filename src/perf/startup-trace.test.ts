import { beforeEach, expect, test } from 'bun:test'
import { startupTrace } from './startup-trace.ts'
import type { Message } from '../session/history.ts'

beforeEach(() => {
	startupTrace.resetForTests()
})

test('drainLines formats ordered startup milestones with deltas', () => {
	startupTrace.markAt('first-code', 14, 'post-import lower bound')
	startupTrace.markAt('runtime-ready', 38, 'host runtime ready')
	startupTrace.markAt('cli-ready', 49, 'prompt ready')

	const lines = startupTrace.drainLines()
	expect(lines).toEqual([
		'[perf] t+14ms first line of code executed; post-import lower bound',
		'[perf] t+38ms runtime initialized (+24ms); host runtime ready',
		'[perf] t+49ms cli initialized (+11ms); prompt ready',
	])
	expect(startupTrace.drainLines()).toEqual([])
})

test('summarizeMessages counts unique blob refs', () => {
	const messages: Message[] = [
		{
			role: 'user',
			content: [{ type: 'image', blobId: 'img-1' }],
			ts: '2026-01-01T00:00:00.000Z',
		},
		{
			role: 'assistant',
			text: 'ok',
			thinkingBlobId: 'think-1',
			tools: [
				{ id: '1', name: 'read', blobId: 'tool-1' },
				{ id: '2', name: 'read', blobId: 'tool-1' },
			],
			ts: '2026-01-01T00:00:01.000Z',
		},
		{ role: 'tool_result', tool_use_id: '1', blobId: 'tool-1', ts: '2026-01-01T00:00:02.000Z' },
	]

	expect(startupTrace.summarizeMessages(messages)).toBe('3 messages, 3 blob refs')
})
