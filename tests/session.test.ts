import { describe, test, expect, afterEach } from 'bun:test'
import { startHal, type TestHal } from './helpers/harness.ts'

let hal: TestHal | null = null

afterEach(async () => {
	if (hal) {
		await hal.stop()
		hal = null
	}
})

describe('session', () => {
	test('/reset clears session', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/reset')
		const event = await hal.waitForLine(/\[reset\] session cleared/)
		expect(event.level).toBe('status')
	})

	test('/cd changes working dir', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/cd /tmp')
		const line = await hal.waitForLine(/\[cd\].*\/tmp/)
		expect(line.level).toBe('status')
		// Sessions event should reflect the new working dir
		const sessions = await hal.waitFor(
			(r) =>
				r.type === 'sessions' &&
				r.sessions?.some((s: any) => s.workingDir === '/tmp'),
		)
		expect(sessions.sessions.some((s: any) => s.workingDir === '/tmp')).toBe(true)
	})

	test('/cd to nonexistent dir shows error', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/cd /nonexistent_xyz_test_dir')
		const event = await hal.waitForLine(/\[cd\] not a directory/)
		expect(event.level).toBe('error')
	})

	test('/cd with no args shows current dir', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/cd')
		const event = await hal.waitForLine(/\[cd\]/)
		expect(event.level).toBe('info')
	})

	test('/cd - returns to previous dir', async () => {
		hal = await startHal()
		await hal.waitForReady()
		// First cd to /tmp
		hal.sendLine('/cd /tmp')
		await hal.waitForLine(/\[cd\].*\/tmp/)
		// Then cd to /
		hal.sendLine('/cd /')
		await hal.waitForLine(/\[cd\].*\/tmp -> \//)
		// Then cd - should go back to /tmp
		hal.sendLine('/cd -')
		const back = await hal.waitForLine(/\[cd\].*\/ -> \/tmp/)
		expect(back.level).toBe('status')
	})
})
