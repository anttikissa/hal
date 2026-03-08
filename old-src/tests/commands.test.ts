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
	test('/model shows current model and lists available', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/model')
		await hal.waitForLine(/\[model\] current:/)
		const list = await hal.waitForLine(/\[model\] available:/)
		expect(list.level).toBe('info')
		expect(list.text).toContain('claude')
	})

	test('/model switches model', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/model codex')
		const event = await hal.waitForLine(/\[model\] .*->.*gpt-5\.4/)
		expect(event.level).toBe('meta')
		expect(event.text).toContain('gpt-5.4')
	})

	test('/system shows prompt info', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/system')
		const event = await hal.waitForLine(/\[system\]/)
		expect(event.level).toBe('info')
	})

	test('/topic persists and can be read back', async () => {
		hal = await startHal()
		await hal.waitForReady()

		hal.sendLine('/topic Fix failing queue tests')
		const setEvent = await hal.waitFor(
			(r) =>
				r.type === 'line' &&
				r.level === 'meta' &&
				r.text === '[topic] Fix failing queue tests',
		)
		expect(setEvent.level).toBe('meta')

		hal.sendLine('/topic')
		const readEvent = await hal.waitFor(
			(r) =>
				r.type === 'line' &&
				r.level === 'info' &&
				r.text === '[topic] Fix failing queue tests',
		)
		expect(readEvent.level).toBe('info')
	})

	test('/topic with no existing topic returns (none)', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/topic')
		const event = await hal.waitForLine(/\[topic\] \(none\)/)
		expect(event.level).toBe('info')
	})

	test('/topic auto-generation ignores generic greeting', async () => {
		hal = await startHal()
		await hal.waitForReady()

		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\] .*->.*mock/)

		hal.sendLine('hello there')
		await hal.waitFor(
			(r) =>
				r.type === 'prompt' &&
				r.text === 'hello there',
			10000,
		)
		await hal.waitFor(
			(r) =>
				r.type === 'chunk' &&
				r.channel === 'assistant' &&
				/Hello, I am a mock model/.test(r.text ?? ''),
			10000,
		)

		hal.sendLine('/topic')
		const event = await hal.waitForLine(/\[topic\] \(none\)/)
		expect(event.level).toBe('info')
	})

	test('/title goes through unknown-command warning path', async () => {
		hal = await startHal()
		await hal.waitForReady()
		hal.sendLine('/title new name')
		const event = await hal.waitForLine(/\[command\] unknown: title/)
		expect(event.level).toBe('warn')
	})
})
