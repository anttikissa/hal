import { describe, test, expect, afterEach } from 'bun:test'
import { startHal, type TestHal } from './helpers/harness.ts'
import { makeCommand } from '../protocol.ts'

let hal: TestHal | null = null

afterEach(async () => {
	if (hal) {
		await hal.stop()
		hal = null
	}
})

const testSource = { kind: 'cli' as const, clientId: 'test-steer' }

async function activeSessionId(hal: TestHal): Promise<string> {
	const event = await hal.waitFor(
		(r) => r.type === 'sessions' && typeof r.active === 'string' && r.sessions?.length >= 1,
	)
	return event.active as string
}

async function waitUntilBusy(hal: TestHal, sessionId: string): Promise<void> {
	await hal.waitFor(
		(r) =>
			r.type === 'status' &&
			Array.isArray(r.busySessions) &&
			r.busySessions.includes(sessionId),
	)
}

async function waitUntilIdle(hal: TestHal, sessionId: string, timeoutMs = 10000): Promise<void> {
	await hal.waitFor(
		(r) =>
			r.type === 'status' &&
			Array.isArray(r.busySessions) &&
			!r.busySessions.includes(sessionId),
		timeoutMs,
	)
}

describe('steer', () => {
	test('prompt while not busy has no label', async () => {
		hal = await startHal()
		await hal.waitForReady()

		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\]/)

		hal.sendLine('hello no label')
		const prompt = await hal.waitForPrompt(/hello no label/)
		expect(prompt.label).toBeUndefined()
	})

	test('prompt while busy has no label', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const sessionId = await activeSessionId(hal)

		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\]/)

		// Start a slow prompt (song) to keep model busy
		hal.sendLine('song')
		await waitUntilBusy(hal, sessionId)

		// Send another prompt while busy — should render like a normal prompt
		hal.sendLine('queued message')
		const prompt = await hal.waitForPrompt(/queued message/)
		expect(prompt.label).toBeUndefined()
	}, 15000)

	test('steer command aborts generation and publishes steering prompt', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const sessionId = await activeSessionId(hal)

		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\]/)

		// Start slow generation
		hal.sendLine('song')
		await waitUntilBusy(hal, sessionId)

		// Queue a message while busy
		hal.sendLine('steered message')
		await hal.waitForPrompt(/steered message/)

		// Send steer command via IPC
		await hal.sendCommand(makeCommand('steer', testSource, undefined, sessionId))

		// Should see a steering prompt echo
		const steeringPrompt = await hal.waitForPrompt(/steered message/, 'steering', 10000)
		expect(steeringPrompt.label).toBe('steering')
		expect(steeringPrompt.text).toBe('steered message')

		// Session should eventually finish
		await waitUntilIdle(hal, sessionId)
	}, 20000)

	test('steer produces no pause/resume noise', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const sessionId = await activeSessionId(hal)

		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\]/)

		// Start generation
		hal.sendLine('song')
		await waitUntilBusy(hal, sessionId)

		// Queue + steer
		hal.sendLine('steer test')
		await hal.waitForPrompt(/steer test/)

		await hal.sendCommand(makeCommand('steer', testSource, undefined, sessionId))

		// Wait for steer to complete
		await hal.waitForPrompt(/steer test/, 'steering', 10000)
		await waitUntilIdle(hal, sessionId)

		// Verify no [pause] or [resume] messages in the records
		const pauseLines = hal.records.filter(
			(r) => r.type === 'line' && /\[pause\]|\[resume\]/.test(r.text ?? ''),
		)
		expect(pauseLines).toEqual([])
	}, 20000)

	test('steer with multiple queued messages promotes last prompt', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const sessionId = await activeSessionId(hal)

		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\]/)

		// Start generation
		hal.sendLine('song')
		await waitUntilBusy(hal, sessionId)

		// Queue multiple messages while busy
		hal.sendLine('first queued')
		await hal.waitForPrompt(/first queued/)

		hal.sendLine('second queued')
		await hal.waitForPrompt(/second queued/)

		// Steer — should promote 'second queued' to front
		await hal.sendCommand(makeCommand('steer', testSource, undefined, sessionId))

		// Should see steering echo for the last queued message
		const steeringPrompt = await hal.waitForPrompt(/second queued/, 'steering', 10000)
		expect(steeringPrompt.text).toBe('second queued')
	}, 20000)

	test('steer on non-busy session is harmless', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const sessionId = await activeSessionId(hal)

		// Send steer while not busy — should complete without error
		const steerCmd = makeCommand('steer', testSource, undefined, sessionId)
		await hal.sendCommand(steerCmd)

		// The steer command should complete (done phase)
		await hal.waitFor(
			(r) =>
				r.type === 'command' &&
				r.commandId === steerCmd.id &&
				r.phase === 'done',
		)

		// No errors
		const errors = hal.records.filter(
			(r) => r.type === 'line' && r.level === 'error',
		)
		expect(errors).toEqual([])
	})

	test('steer command done phase is emitted', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const sessionId = await activeSessionId(hal)

		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\]/)

		// Start generation
		hal.sendLine('song')
		await waitUntilBusy(hal, sessionId)

		// Queue + steer
		hal.sendLine('check done phase')
		await hal.waitForPrompt(/check done phase/)

		const steerCmd = makeCommand('steer', testSource, undefined, sessionId)
		await hal.sendCommand(steerCmd)

		// Steer command itself should reach 'done'
		await hal.waitFor(
			(r) =>
				r.type === 'command' &&
				r.commandId === steerCmd.id &&
				r.phase === 'done',
			10000,
		)
	}, 20000)
})
