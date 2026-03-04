import { beforeEach, describe, expect, test } from 'bun:test'
import type { SessionInfo } from '../session.ts'
import { _testClient } from './client.ts'
import { createTabState } from './tab.ts'
import { _testCursor, restoreHalIdleTimer, setActiveTabCursor, setHalState } from './tui.ts'

const TEST_TS = '2026-01-01T00:00:00.000Z'

function mkSession(id: string, workingDir: string, busy: boolean): SessionInfo {
	return { id, workingDir, busy, messageCount: 0, createdAt: TEST_TS, updatedAt: TEST_TS }
}

describe('client cursor state', () => {
	beforeEach(() => {
		_testClient.resetState()
		_testCursor.resetAll()
	})

	test('sessions sync preserves dormant active cursor while another tab becomes busy', () => {
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
		_testClient.setTabs([tab1, tab2], 1)

		setActiveTabCursor('tab2')
		setHalState('idle', 'tab2')
		const idleSince = Date.now() - 60_000
		restoreHalIdleTimer(idleSince)
		expect(_testCursor.isDormant()).toBe(true)

		_testClient.syncTabsFromSessions(
			[
				mkSession('tab1', '/tmp/tab1', true),
				mkSession('tab2', '/tmp/tab2', false),
			],
			'tab2',
		)

		expect(_testCursor.isDormant()).toBe(true)
		const active = _testClient.getActiveTab()
		expect(active?.sessionId).toBe('tab2')
		expect(active?.halIdleSince ?? Infinity).toBeLessThan(Date.now() - 30_000)
	})
})
