import { beforeEach, describe, expect, test } from 'bun:test'
import type { SessionInfo } from '../session.ts'
import { buildTabFromSession } from './client.ts'
import { createTabState } from './tab.ts'
import { getHalIdleSince, restoreHalIdleTimer, setActiveTabCursor, setHalState } from './tui.ts'

const TEST_TS = '2026-01-01T00:00:00.000Z'

function mkSession(id: string, workingDir: string, busy: boolean): SessionInfo {
	return { id, workingDir, busy, messageCount: 0, createdAt: TEST_TS, updatedAt: TEST_TS }
}

function mkExistingTab(sessionId: string, workingDir: string, halIdleSince: number) {
	return {
		...createTabState({
			sessionId,
			workingDir,
			name: sessionId,
			modelLabel: 'Codex 5.3',
		}),
		halIdleSince,
	}
}

describe('buildTabFromSession', () => {
	beforeEach(() => {
		setActiveTabCursor('test-reset')
		setHalState('writing', 'test-reset')
		setHalState('idle', 'test-reset')
		restoreHalIdleTimer(Date.now())
	})

	test('preserves existing halIdleSince', () => {
		const oldIdleSince = Date.now() - 60_000
		const existing = mkExistingTab('tab2', '/tmp/tab2', oldIdleSince)
		const next = buildTabFromSession(
			mkSession('tab2', '/tmp/tab2', false),
			existing,
			{ preserve: true, forkOutput: null, isRestore: false, restoreData: null },
		)

		expect(next.halIdleSince).toBe(oldIdleSince)
	})

	test('preserved halIdleSince keeps cursor dormant after restore', () => {
		const oldIdleSince = Date.now() - 60_000
		const existing = mkExistingTab('tab2', '/tmp/tab2', oldIdleSince)
		const next = buildTabFromSession(
			mkSession('tab2', '/tmp/tab2', false),
			existing,
			{ preserve: true, forkOutput: null, isRestore: false, restoreData: null },
		)

		restoreHalIdleTimer(next.halIdleSince)

		expect(getHalIdleSince()).toBeLessThan(Date.now() - 30_000)
	})

	test('sets halIdleSince for brand-new tabs', () => {
		const start = Date.now()
		const next = buildTabFromSession(
			mkSession('tab-new', '/tmp/tab-new', false),
			undefined,
			{ preserve: true, forkOutput: null, isRestore: false, restoreData: null },
		)

		expect(next.halIdleSince).toBeGreaterThanOrEqual(start)
		expect(next.halIdleSince).toBeLessThanOrEqual(Date.now())
	})
})
