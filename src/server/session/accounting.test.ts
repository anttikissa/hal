import { afterEach, expect, test } from 'bun:test'
import { accounting } from './accounting.ts'
import { sessions } from '../sessions.ts'
import { apiMessages } from './api-messages.ts'

const append = sessions.appendHistory

afterEach(() => { sessions.appendHistory = append })

test('one compact receipt totals multiple calls and freezes API-equivalent cost', () => {
	const saved: any[] = []
	sessions.appendHistory = (_id, entries) => { saved.push(...entries) }
	const meter = accounting.start('openai/gpt-6-astra', 'turn')
	meter.requests++
	accounting.add(meter, { input: 100, output: 10, cacheRead: 200 })
	meter.requests++
	accounting.add(meter, { input: 200, output: 20, cacheRead: 100 })
	expect(saved).toEqual([])
	accounting.save('session', meter)
	expect(saved).toHaveLength(1)
	expect(saved[0]).toMatchObject({ type: 'usage', model: 'openai/gpt-6-astra', purpose: 'turn', requests: 2, usage: { input: 300, output: 30, cacheRead: 300, cacheCreation: 0 } })
	expect(saved[0].apiUsd).toBeCloseTo(0.0048)
	expect(saved[0].incomplete).toBeUndefined()
	expect(saved[0].durationMs).toBeGreaterThanOrEqual(0)
})

test('missing provider usage is unknown, while unknown pricing never becomes free', () => {
	const saved: any[] = []
	sessions.appendHistory = (_id, entries) => { saved.push(...entries) }
	const meter = accounting.start('other/unknown', 'summary')
	accounting.save('session', meter)
	expect(saved).toHaveLength(0)
	meter.requests = 2
	accounting.add(meter, { input: 0, output: 0 })
	accounting.save('session', meter)
	expect(saved[0]).toMatchObject({ purpose: 'summary', requests: 2, incomplete: true })
	expect(saved[0].apiUsd).toBeUndefined()
})

test('receipt fields survive history persistence without becoming model context', () => {
	const id = `test-accounting-${Date.now().toString(36)}`
	sessions.createSession(id, { id, createdAt: new Date().toISOString() })
	try {
		const meter = accounting.start('openai/gpt-6-astra', 'summary')
		meter.requests = 2
		accounting.add(meter, { input: 100, output: 10 })
		accounting.save(id, meter)
		const receipt = sessions.loadHistory(id)[0]
		expect(receipt).toMatchObject({ type: 'usage', purpose: 'summary', requests: 2, incomplete: true, apiUsd: 0.0015 })
		expect(receipt?.id).toBeDefined()
		expect(apiMessages.toProviderMessages(id)).toEqual([])
	} finally {
		sessions.deleteSession(id)
	}
})
