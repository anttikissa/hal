import { expect, test } from 'bun:test'
import { toolRegistry } from './tool.ts'
import type { Message } from '../protocol.ts'
import { builtins } from './builtins.ts'
import { analyzeHistory } from './analyze_history.ts'

builtins.init()
test('registers the analyze_history tool', () => {
	expect(toolRegistry.getTool('analyze_history')?.name).toBe('analyze_history')
})

test('rolling pruning can cost more than keeping the full cached prefix', () => {
	const prefix = 'p'.repeat(6000)
	const huge = 'x'.repeat(6000)
	const tail = 'y'.repeat(120000)
	const tail2 = 'z'.repeat(120000)
	const request1: Message[] = [
		{ role: 'user', content: prefix },
		{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.ts' } }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }] },
	]
	const request2: Message[] = [
		...request1,
		{ role: 'assistant', content: [{ type: 'text', text: tail }] },
		{ role: 'user', content: 'next task' },
	]
	const request3: Message[] = [
		...request2,
		{ role: 'assistant', content: [{ type: 'text', text: tail2 }] },
		{ role: 'user', content: 'third task' },
	]

	const out = analyzeHistory.analyzeSnapshots([request1, request2, request3], {
		inputPrice: 2.5,
		cachedInputPrice: 0.25,
		heavyThreshold: 1,
		thinkingThreshold: 10,
		batchSizes: [3],
		retryRate: 0,
		retryCostTokens: 0,
	})
	const keepAll = out.keep_all!
	const rolling = out.rolling_prune!
	const batch = out.batch_prune_3!

	expect(keepAll.costUsd).toBeLessThan(rolling.costUsd)
	expect(batch.costUsd).toBe(keepAll.costUsd)
	expect(rolling.prunedReadResults).toBeGreaterThan(0)
})
