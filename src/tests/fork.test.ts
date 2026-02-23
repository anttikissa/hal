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

	test('/fork while generating does not interrupt original session', async () => {
		hal = await startHal()
		await hal.waitForReady()

		// Switch to mock provider (streams song slowly at 120ms/syllable)
		hal.sendLine('/model mock')
		await hal.waitForLine(/switched to mock/)

		// Start generating a song (~5 seconds of streaming)
		hal.sendLine('song')

		// Wait for a few chunks to confirm generation started
		await hal.waitFor(
			(r) => r.type === 'chunk' && r.channel === 'assistant' && /Dai/.test(r.text ?? ''),
		)

		// Fork while generating
		hal.sendLine('/fork')
		await hal.waitForLine(/\[fork\] forked/)

		// Record how many chunks we had at fork time
		const chunksAtFork = hal.records.filter(
			(r) => r.type === 'chunk' && r.channel === 'assistant',
		).length

		// Wait for the song to finish — "two.\n" is the last syllable
		await hal.waitFor(
			(r) => r.type === 'chunk' && r.channel === 'assistant' && /two/.test(r.text ?? ''),
			10000,
		)

		// Should have received more chunks after the fork
		const chunksAtEnd = hal.records.filter(
			(r) => r.type === 'chunk' && r.channel === 'assistant',
		).length
		expect(chunksAtEnd).toBeGreaterThan(chunksAtFork)

		// Should have 2 sessions now
		const sessions = await hal.waitFor(
			(r) => r.type === 'sessions' && r.sessions?.length >= 2,
		)
		expect(sessions.sessions.length).toBeGreaterThanOrEqual(2)
	}, 15000)
})
