import { describe, test, expect, afterEach } from 'bun:test'
import { startHal, type TestHal } from './helpers/harness.ts'

let hal: TestHal | null = null

afterEach(async () => {
	if (hal) {
		await hal.stop()
		hal = null
	}
})

describe('fork', () => {
	test('/fork creates new session', async () => {
		hal = await startHal()
		await hal.waitForReady()

		// Wait for initial session to be established
		const initial = await hal.waitFor(
			(r) => r.type === 'sessions' && r.sessions?.length >= 1,
		)
		const originalId = initial.sessions[0].id

		hal.sendLine('/fork')

		// Should see fork status line
		await hal.waitForLine(/\[fork\] forked/)

		// Sessions event should now have more than 1 session
		const sessions = await hal.waitFor(
			(r) => r.type === 'sessions' && r.sessions?.length >= 2,
		)
		expect(sessions.sessions.length).toBeGreaterThanOrEqual(2)


		// Original session should still exist
		expect(sessions.sessions.some((s: any) => s.id === originalId)).toBe(true)
	})
})
