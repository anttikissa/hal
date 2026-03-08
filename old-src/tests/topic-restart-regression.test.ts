import { describe, test, expect, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { startHal, type TestHal } from './helpers/harness.ts'

let hal: TestHal | null = null

afterEach(async () => {
	if (hal) {
		await hal.stop()
		hal = null
	}
})

describe('topic restart regression', () => {
	test('restart + greeting does not set generic auto-topic', async () => {
		hal = await startHal({
			setup: ({ stateDir }) => {
				const sessionsDir = `${stateDir}/sessions`
				const sessionDir = `${sessionsDir}/s-default`
				mkdirSync(sessionDir, { recursive: true })
				writeFileSync(
					`${sessionsDir}/index.ason`,
					`{
	activeSessionId: 's-default',
	sessions: [
		{
			id: 's-default',
			workingDir: '/tmp',
			busy: false,
			messageCount: 2,
			createdAt: '2026-02-28T00:00:00.000Z',
			updatedAt: '2026-02-28T00:00:00.000Z',
			model: 'mock/mock-1',
		},
	],
}
`,
				)
				writeFileSync(
					`${sessionDir}/messages.asonl`,
					`{ role: 'user', content: 'Need help fixing topic persistence', ts: '2026-02-28T00:00:00.000Z' }
{ role: 'assistant', text: 'Sure, let us debug it.', ts: '2026-02-28T00:00:01.000Z' }
`,
				)
				writeFileSync(
					`${sessionDir}/info.ason`,
					`{ workingDir: '/tmp', updatedAt: '2026-02-28T00:00:00.000Z', tokenTotals: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 } }
`,
				)
			},
		})
		await hal.waitForReady()

		hal.sendLine('hi')
		await hal.waitFor(
			(r) =>
				r.type === 'prompt' &&
				r.text === 'hi',
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
		const topicLine = await hal.waitForLine(/\[topic\]/, 10000)
		// Should generate a meaningful topic from prior context, not a generic greeting topic
		expect(topicLine.text).not.toMatch(/greeting|no response/i)
	})
})
