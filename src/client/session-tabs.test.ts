import { expect, test } from 'bun:test'
import { sessionTabs } from './session-tabs.ts'

function tab(sessionId: string): any {
	return {
		sessionId,
		name: sessionId,
		history: [],
		inputHistory: [],
		inputDraft: '',
		parentEntryCount: 0,
		loaded: true,
		doneUnseen: false,
		historyVersion: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
		contextUsed: 0,
		contextMax: 0,
		cwd: '',
		model: '',
	}
}

function ctx(overrides: any = {}): any {
	return {
		makeTabFromDisk: (item: any) => tab(item.id),
		pruneRecentTabs: () => {},
		ensureTabLoaded: () => {},
		loadTabBlobs: () => {},
		rememberTab: () => {},
		flushPendingEntries: () => {},
		addStartupSummaryToTab: () => {},
		addTabNoticeToTab: () => {},
		showRestoreTabHint: () => {},
		clearRestoreTabHint: () => {},
		onTabSwitch: () => {},
		onChange: () => {},
		...overrides,
	}
}

test('closing a tab shows the restore-tab help hint', () => {
	sessionTabs.reset()
	let shown = 0
	const model = {
		tabs: [tab('left'), tab('right')],
		focusedTabIndex: 0,
		recentTabs: ['left'],
	}

	sessionTabs.apply([{ id: 'right' } as any], '', ctx({
		model,
		showRestoreTabHint: () => { shown++ },
	}))

	expect(shown).toBe(1)
})

test('restoring a tab clears the restore-tab help hint', () => {
	sessionTabs.reset()
	sessionTabs.state.pendingOpen = 'resume'
	let cleared = 0
	const model = {
		tabs: [tab('right')],
		focusedTabIndex: 0,
		recentTabs: ['right'],
	}

	sessionTabs.apply([{ id: 'left' } as any, { id: 'right' } as any], '', ctx({
		model,
		clearRestoreTabHint: () => { cleared++ },
	}))

	expect(cleared).toBe(1)
})
