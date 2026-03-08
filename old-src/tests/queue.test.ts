import { describe, test, expect, afterEach } from 'bun:test'
import { startHal, type TestHal } from './helpers/harness.ts'

let hal: TestHal | null = null

afterEach(async () => {
	if (hal) {
		await hal.stop()
		hal = null
	}
})

function knownCommandIds(hal: TestHal): Set<string> {
	return new Set(
		hal.records
			.filter((r) => r.type === 'command' && typeof r.commandId === 'string')
			.map((r) => r.commandId as string),
	)
}

async function waitForNewCommandPhase(
	hal: TestHal,
	sessionId: string,
	phase: 'queued' | 'started' | 'done' | 'failed',
	seen: Set<string>,
	timeoutMs = 5000,
): Promise<any> {
	const event = await hal.waitFor(
		(r) =>
			r.type === 'command' &&
			r.session === sessionId &&
			r.phase === phase &&
			typeof r.commandId === 'string' &&
			!seen.has(r.commandId),
		timeoutMs,
	)
	seen.add(event.commandId)
	return event
}

async function activeSessionId(hal: TestHal): Promise<string> {
	const event = await hal.waitFor(
		(r) => r.type === 'sessions' && typeof r.active === 'string' && r.sessions?.length >= 1,
	)
	return event.active as string
}

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

	test('paused session accumulates queued commands and /queue lists them in order', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const sessionId = await activeSessionId(hal)

		hal.sendLine('/pause')
		await hal.waitFor(
			(r) =>
				r.type === 'status' &&
				Array.isArray(r.pausedSessions) &&
				r.pausedSessions.includes(sessionId),
		)

		const seen = knownCommandIds(hal)
		hal.sendLine('/model codex')
		await waitForNewCommandPhase(hal, sessionId, 'queued', seen)

		hal.sendLine('/topic queued-topic')
		await waitForNewCommandPhase(hal, sessionId, 'queued', seen)

		hal.sendLine('/queue')
		await hal.waitForLine(/\[queue\] 2 message\(s\):/)
		await hal.waitForLine(/1\. codex/)
		await hal.waitForLine(/2\. queued-topic/)
	})

	test('/drop fails queued commands and clears paused state', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const sessionId = await activeSessionId(hal)

		hal.sendLine('/pause')
		await hal.waitFor(
			(r) =>
				r.type === 'status' &&
				Array.isArray(r.pausedSessions) &&
				r.pausedSessions.includes(sessionId),
		)

		const seen = knownCommandIds(hal)
		hal.sendLine('/model codex')
		const queuedModel = await waitForNewCommandPhase(hal, sessionId, 'queued', seen)

		hal.sendLine('/topic drop-topic')
		const queuedTopic = await waitForNewCommandPhase(hal, sessionId, 'queued', seen)

		hal.sendLine('/drop')
		await hal.waitForLine(/\[drop\] cleared 2 queued message\(s\)/)

		const modelFailed = await hal.waitFor(
			(r) =>
				r.type === 'command' &&
				r.commandId === queuedModel.commandId &&
				r.phase === 'failed',
		)
		const topicFailed = await hal.waitFor(
			(r) =>
				r.type === 'command' &&
				r.commandId === queuedTopic.commandId &&
				r.phase === 'failed',
		)
		expect(modelFailed.message).toBe('dropped by user')
		expect(topicFailed.message).toBe('dropped by user')

		await Bun.sleep(100)
		const statusEvents = hal.records.filter(
			(r) => r.type === 'status' && Array.isArray(r.pausedSessions),
		)
		expect(statusEvents.length).toBeGreaterThan(0)
		const lastStatus = statusEvents[statusEvents.length - 1]
		expect(lastStatus.pausedSessions).not.toContain(sessionId)
	})

	test('prompt while paused auto-resumes', async () => {
		hal = await startHal()
		await hal.waitForReady()
		const sessionId = await activeSessionId(hal)

		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\] .*->.*mock/)

		hal.sendLine('/pause')
		await hal.waitFor(
			(r) =>
				r.type === 'status' &&
				Array.isArray(r.pausedSessions) &&
				r.pausedSessions.includes(sessionId),
		)

		const seen = knownCommandIds(hal)
		hal.sendLine('hello while paused')
		const promptQueued = await waitForNewCommandPhase(hal, sessionId, 'queued', seen)

		await hal.waitFor(
			(r) =>
				r.type === 'status' &&
				Array.isArray(r.busySessions) &&
				Array.isArray(r.pausedSessions) &&
				r.busySessions.includes(sessionId) &&
				!r.pausedSessions.includes(sessionId),
			10000,
		)

		await hal.waitFor(
			(r) =>
				r.type === 'command' &&
				r.commandId === promptQueued.commandId &&
				r.phase === 'done',
			10000,
		)
	}, 15000)
})
