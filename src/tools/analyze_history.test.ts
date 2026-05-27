import { expect, test } from 'bun:test'
import { toolRegistry } from './tool.ts'
import type { Message } from '../protocol.ts'
import { builtins } from './builtins.ts'
import { analyzeHistory } from './analyze_history.ts'
import { sessions } from '../server/sessions.ts'
import { apiMessages } from '../session/api-messages.ts'

builtins.init()
test('registers the analyze_history tool', () => {
	expect(toolRegistry.getTool('analyze_history')?.name).toBe('analyze_history')
})

test('execute stops before expensive history loading when time budget is exhausted', async () => {
	const oldMaxSeconds = analyzeHistory.config.maxSeconds
	const oldLoadAllSessionMetas = sessions.loadAllSessionMetas
	const oldLoadAllHistory = sessions.loadAllHistory
	analyzeHistory.config.maxSeconds = 0
	sessions.loadAllSessionMetas = () => [{ id: 'slow-session', createdAt: '2026-01-01T00:00:00.000Z' } as any]
	sessions.loadAllHistory = () => {
		throw new Error('history should not load after budget expires')
	}
	try {
		const output = JSON.parse(await analyzeHistory.execute({ limit: 1 }, { sessionId: 'test', cwd: '.' }))
		expect(output.stoppedEarly).toBe(true)
		expect(output.sessionsAnalyzed).toBe(0)
	} finally {
		analyzeHistory.config.maxSeconds = oldMaxSeconds
		sessions.loadAllSessionMetas = oldLoadAllSessionMetas
		sessions.loadAllHistory = oldLoadAllHistory
	}
})

test('execute yields to the event loop while scanning history', async () => {
	const oldMaxSeconds = analyzeHistory.config.maxSeconds
	const oldYieldEverySnapshots = analyzeHistory.config.yieldEverySnapshots
	const oldLoadAllSessionMetas = sessions.loadAllSessionMetas
	const oldLoadAllHistory = sessions.loadAllHistory
	const oldToProviderMessages = apiMessages.toProviderMessages
	const entries: any[] = []
	for (let i = 0; i < 5; i++) {
		entries.push({ type: 'user', ts: '2026-01-01T00:00:00.000Z', parts: [{ type: 'text', text: `turn ${i}` }] })
	}
	analyzeHistory.config.maxSeconds = 60
	analyzeHistory.config.yieldEverySnapshots = 1
	sessions.loadAllSessionMetas = () => [{ id: 'yield-session', createdAt: '2026-01-01T00:00:00.000Z' } as any]
	sessions.loadAllHistory = () => entries as any
	apiMessages.toProviderMessages = () => [{ role: 'user', content: 'snapshot' }]
	try {
		let done = false
		const promise = analyzeHistory.execute({ limit: 1 }, { sessionId: 'test', cwd: '.' }).then(() => {
			done = true
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(done).toBe(false)
		await promise
	} finally {
		analyzeHistory.config.maxSeconds = oldMaxSeconds
		analyzeHistory.config.yieldEverySnapshots = oldYieldEverySnapshots
		sessions.loadAllSessionMetas = oldLoadAllSessionMetas
		sessions.loadAllHistory = oldLoadAllHistory
		apiMessages.toProviderMessages = oldToProviderMessages
	}
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
