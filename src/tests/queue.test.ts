import { describe, test, expect, afterEach } from 'bun:test'
import { startHal, type TestHal } from './helpers/harness.ts'

let hal: TestHal | null = null

afterEach(async () => {
	if (hal) {
		await hal.stop()
		hal = null
	}
})

describe('queue', () => {
	test('/queue on empty session shows empty', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/queue')
		const event = await hal.waitForLine(/\[queue\] empty/)
		expect(event.level).toBe('meta')
	})

	test('/drop on empty queue shows empty', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/drop')
		const event = await hal.waitForLine(/\[drop\] queue is empty/)
		expect(event.level).toBe('meta')
	})

	test('/resume on non-paused session is silent', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/resume')
		// Should complete without error — wait for the done phase
		const event = await hal.waitFor(
			(r) => r.type === 'command' && r.phase === 'done',
		)
		expect(event.phase).toBe('done')
	})
})
