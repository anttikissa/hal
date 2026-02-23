import { describe, test, expect, afterEach } from 'bun:test'
import { startHal, type TestHal } from './helpers/harness.ts'

let hal: TestHal | null = null

afterEach(async () => {
	if (hal) {
		await hal.stop()
		hal = null
	}
})

describe('startup', () => {
	test('emits ready', async () => {
		hal = await startHal()
		await hal.waitForReady()
	})

	test('emits session event', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const event = await hal.waitForLine(/\[session\]/)
		expect(event.text).toContain('[session]')
		expect(event.level).toBe('meta')
	})

	test('emits model event', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const event = await hal.waitForLine(/\[model\]/)
		expect(event.text).toContain('[model]')
		expect(event.level).toBe('meta')
	})

	test('emits context status', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const event = await hal.waitFor((e) => e.type === 'status' && !!e.context)
		expect(event.context).toBeDefined()
		expect(event.context.used).toBeGreaterThanOrEqual(0)
		expect(event.context.max).toBeGreaterThan(0)
	})

	test('emits sessions list', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const event = await hal.waitFor((r) => r.type === 'sessions' && Array.isArray(r.sessions))
		expect(event.sessions.length).toBeGreaterThanOrEqual(1)
		expect(event.sessions[0].id).toBeTruthy()
	})

	test('exits cleanly on EOF', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const { exitCode } = await hal.stop()
		expect(exitCode).toBe(0)
		hal = null // already stopped
	})
})
