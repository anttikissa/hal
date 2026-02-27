import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { startHal, type TestHal } from './helpers/harness.ts'

let hal: TestHal | null = null
const cleanupDirs = new Set<string>()

beforeEach(() => {
	Bun.env.HAL_TEST_NO_UI = '1'
})

afterEach(async () => {
	if (hal) {
		await hal.stop()
		hal = null
	}
	for (const dir of cleanupDirs) {
		rmSync(dir, { recursive: true, force: true })
	}
	cleanupDirs.clear()
})

async function activeSessionId(instance: TestHal): Promise<string> {
	const event = await instance.waitFor(
		(r) => r.type === 'sessions' && typeof r.active === 'string' && r.sessions?.length >= 1,
	)
	return event.active as string
}

describe('restore/replay', () => {
	test('conversation replay after restart', async () => {
		hal = await startHal({ cleanupOnStop: false })
		const sharedDir = hal.halDir
		cleanupDirs.add(sharedDir)
		await hal.waitForReady()

		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\] .*->.*mock/)
		const known = new Set(
			hal.records
				.filter((r) => r.type === 'command' && typeof r.commandId === 'string')
				.map((r) => r.commandId as string),
		)

		hal.sendLine('replay this prompt')
		const queued = await hal.waitFor(
			(r) =>
				r.type === 'command' &&
				typeof r.commandId === 'string' &&
				r.phase === 'queued' &&
				!known.has(r.commandId),
			10000,
		)
		await hal.waitFor(
			(r) => r.type === 'prompt' && r.text === 'replay this prompt',
			10000,
		)
		await hal.waitFor(
			(r) =>
				r.type === 'command' &&
				r.commandId === queued.commandId &&
				r.phase === 'done',
			15000,
		)
		await hal.waitFor(
			(r) =>
				r.type === 'chunk' &&
				r.channel === 'assistant' &&
				/Hello, I am a mock model/.test(r.text ?? ''),
			10000,
		)

		await hal.stop({ keepDir: true })
		hal = null

		hal = await startHal({ halDir: sharedDir, cleanupOnStop: false })
		await hal.waitForReady()
		await hal.waitFor(
			(r) => r.type === 'prompt' && r.text === 'replay this prompt',
			10000,
		)
		await hal.waitFor(
			(r) =>
				r.type === 'chunk' &&
				r.channel === 'assistant' &&
				/Hello, I am a mock model/.test(r.text ?? ''),
			10000,
		)
	}, 30000)

	test('registry active session restoration prefers non-first session', async () => {
		hal = await startHal({
			setup: ({ stateDir }) => {
				const sessionsDir = `${stateDir}/sessions`
				mkdirSync(sessionsDir, { recursive: true })
				writeFileSync(
					`${sessionsDir}/index.ason`,
					`{
	activeSessionId: 's-b',
	sessions: [
		{
			id: 's-a',
			workingDir: '/tmp',
			busy: false,
			messageCount: 0,
			createdAt: '2026-02-27T00:00:00.000Z',
			updatedAt: '2026-02-27T00:00:00.000Z'
		},
		{
			id: 's-b',
			workingDir: '/tmp',
			busy: false,
			messageCount: 0,
			createdAt: '2026-02-27T00:00:00.000Z',
			updatedAt: '2026-02-27T00:00:00.000Z'
		}
	]
}
`,
				)
			},
		})
		await hal.waitForReady()
		const active = await activeSessionId(hal)
		expect(active).toBe('s-b')
	})

	test('draft file persists across restart', async () => {
		hal = await startHal({ cleanupOnStop: false })
		const sharedDir = hal.halDir
		cleanupDirs.add(sharedDir)
		await hal.waitForReady()

		const sessionId = await activeSessionId(hal)
		const draftPath = `${sharedDir}/state/sessions/${sessionId}/draft.txt`
		mkdirSync(`${sharedDir}/state/sessions/${sessionId}`, { recursive: true })
		writeFileSync(draftPath, 'draft survives restart')

		await hal.stop({ keepDir: true })
		hal = null

		hal = await startHal({ halDir: sharedDir, cleanupOnStop: false })
		await hal.waitForReady()
		expect(readFileSync(draftPath, 'utf-8')).toBe('draft survives restart')
	}, 20000)
})
