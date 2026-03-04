import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import type { SessionInfo } from '../session.ts'
import { createTabState } from './tab.ts'
import { getHalIdleSince, restoreHalIdleTimer, setActiveTabCursor, setHalState } from './tui.ts'

const TEST_TS = '2026-01-01T00:00:00.000Z'

function mkSession(id: string, workingDir: string, busy: boolean): SessionInfo {
	return { id, workingDir, busy, messageCount: 0, createdAt: TEST_TS, updatedAt: TEST_TS }
}

const clientPath = resolve(import.meta.dir, 'client.ts')
let tempClientPath = ''
let hooks: {
	reset(): void
	setTabs(nextTabs: any[], activeIndex?: number): void
	getActiveTab(): any
	syncTabsFromSessions(sessions: SessionInfo[], preferredActiveSessionId: string | null): void
}

beforeAll(async () => {
	const src = readFileSync(clientPath, 'utf-8')
	const patched = `${src}
export const __testClientHooks = {
	reset(): void {
		source = { kind: 'cli', clientId: 'test' }
		isOwner = false; stopped = false; lastContextStatus = null
		roleLabel = ''; wasBusyOnLastSubmit = false; reconstructing = false
		tabs = []; activeTabIndex = 0; launchCwd = ''
		pendingForkOutput = null; pendingForkSwitch = false
		pendingOpenSwitch = false; pendingOpenData = null
		tabHasActivity = new Set<string>()
		screenFmt = createFormatState()
	},
	setTabs(nextTabs: CliTab[], activeIndex = 0): void {
		tabs = nextTabs
		activeTabIndex = Math.max(0, Math.min(activeIndex, tabs.length - 1))
		tabHasActivity = new Set<string>()
	},
	getActiveTab(): CliTab | null { return activeTab() },
	syncTabsFromSessions,
}
`
	tempClientPath = resolve(import.meta.dir, `client.__cursor_test__.${process.pid}.${Date.now()}.ts`)
	writeFileSync(tempClientPath, patched)
	hooks = (await import(pathToFileURL(tempClientPath).href)).__testClientHooks
})

afterAll(() => {
	if (tempClientPath) rmSync(tempClientPath, { force: true })
})

describe('client cursor state', () => {
	beforeEach(() => {
		hooks.reset()
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
		hooks.setTabs([tab1, tab2], 1)

		setActiveTabCursor('tab2')
		setHalState('idle', 'tab2')
		const idleSince = Date.now() - 60_000
		restoreHalIdleTimer(idleSince)
		expect(getHalIdleSince()).toBeLessThan(Date.now() - 30_000)

		hooks.syncTabsFromSessions(
			[
				mkSession('tab1', '/tmp/tab1', true),
				mkSession('tab2', '/tmp/tab2', false),
			],
			'tab2',
		)

		const active = hooks.getActiveTab()
		expect(active?.sessionId).toBe('tab2')
		expect(active?.halIdleSince ?? Infinity).toBeLessThan(Date.now() - 30_000)
		expect(getHalIdleSince()).toBeLessThan(Date.now() - 30_000)
	})
})
