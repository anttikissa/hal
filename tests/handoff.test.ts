import { describe, test, expect, afterEach } from 'bun:test'
import { startHal, type TestHal } from './helpers/harness.ts'

let hal: TestHal | null = null

afterEach(async () => {
	if (hal) {
		await hal.stop()
		hal = null
	}
})

describe('handoff', () => {
	test('empty session warns nothing to hand off', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/handoff')
		const event = await hal.waitForLine(/nothing to hand off/)
		expect(event.level).toBe('warn')
	})
})
