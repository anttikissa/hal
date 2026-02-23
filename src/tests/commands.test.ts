import { describe, test, expect, afterEach } from 'bun:test'
import { startHal, type TestHal } from './helpers/harness.ts'

let hal: TestHal | null = null

afterEach(async () => {
	if (hal) {
		await hal.stop()
		hal = null
	}
})

describe('commands', () => {
	test('/model shows current model', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/model')
		const event = await hal.waitForLine(/\[model\] current:/)
		expect(event.level).toBe('info')
	})

	test('/model switches model', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/model codex')
		const event = await hal.waitForLine(/\[model\] .*->.*codex/)
		expect(event.level).toBe('meta')
		expect(event.text).toContain('codex')
	})

	test('/system shows prompt info', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/system')
		const event = await hal.waitForLine(/\[system\]/)
		expect(event.level).toBe('info')
	})
})
