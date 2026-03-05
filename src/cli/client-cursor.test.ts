import { beforeEach, describe, expect, test } from 'bun:test'
import type { SessionInfo } from '../session.ts'
import { clientState } from './client.ts'
import { createTabState } from './tab.ts'
import { getHalIdleSince, restoreHalIdleTimer, setActiveTabCursor, setHalState } from './tui.ts'

const TEST_TS = '2026-01-01T00:00:00.000Z'

function mkSession(id: string, workingDir: string, busy: boolean): SessionInfo {
	return { id, workingDir, busy, messageCount: 0, createdAt: TEST_TS, updatedAt: TEST_TS }
}

describe('client cursor state', () => {
	beforeEach(() => {
		clientState.setTabsForTest([], 0)
		setActiveTabCursor('test-reset')
		setHalState('writing', 'test-reset')
		setHalState('idle', 'test-reset')
		restoreHalIdleTimer(Date.now())
	})

	test('sessions sync preserves active tab idle timer', () => {
		const tab1 = createTabState({
			sessionId: 'tab1',
			workingDir: '/tmp/tab1',
			name: 'tab1',
			modelLabel: 'Codex 5.3',
		})
		const tab2 = createTabState({
			sessionId: 'tab2',
			workingDir: '/tmp/tab2',
			name: 'tab2',
			modelLabel: 'Codex 5.3',
		})
		clientState.setTabsForTest([tab1, tab2], 1)

		setActiveTabCursor('tab2')
		setHalState('idle', 'tab2')
		const idleSince = Date.now() - 60_000
		restoreHalIdleTimer(idleSince)
		expect(getHalIdleSince()).toBeLessThan(Date.now() - 30_000)

		clientState.syncTabsFromSessionsForTest(
			[
				mkSession('tab1', '/tmp/tab1', true),
				mkSession('tab2', '/tmp/tab2', false),
			],
			'tab2',
		)

		const active = clientState.getActiveTabForTest()
		expect(active?.sessionId).toBe('tab2')
		expect(active?.halIdleSince ?? Infinity).toBeLessThan(Date.now() - 30_000)
		expect(getHalIdleSince()).toBeLessThan(Date.now() - 30_000)
	})
})
