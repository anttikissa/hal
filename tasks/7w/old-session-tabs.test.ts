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
		attention: undefined,
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

test('focusing a newly opened tab forces a canonical repaint', () => {
	sessionTabs.reset()
	sessionTabs.state.pendingOpen = 'open'
	const model = {
		tabs: [tab('left')],
		focusedTabIndex: 0,
		recentTabs: ['left'],
	}
	const repaints: boolean[] = []

	sessionTabs.apply([{ id: 'left' } as any, { id: 'new' } as any], 'left', ctx({
		model,
		onChange: (force: boolean) => { repaints.push(force) },
	}))

	expect(model.focusedTabIndex).toBe(1)
	expect(repaints).toEqual([true])
})

test('pending open survives unrelated session refresh until the new tab arrives', () => {
	sessionTabs.reset()
	sessionTabs.state.pendingOpen = 'open'
	const model = {
		tabs: [tab('left')],
		focusedTabIndex: 0,
		recentTabs: ['left'],
	}
	const c = ctx({ model })

	// IPC state changes often update working/client metadata without changing the
	// actual tab list. Do not consume the pending open on those refreshes.
	sessionTabs.apply([{ id: 'left' } as any], 'left', c)
	expect(sessionTabs.state.pendingOpen).toBe('open')
	expect(model.focusedTabIndex).toBe(0)

	sessionTabs.apply([{ id: 'left' } as any, { id: 'new' } as any], 'left', c)

	expect(model.focusedTabIndex).toBe(1)
	expect(model.tabs[1]?.sessionId).toBe('new')
	expect(sessionTabs.state.pendingOpen).toBeFalsy()
})

test('an immediately closed newly opened tab returns to its opener', () => {
	sessionTabs.reset()
	sessionTabs.state.pendingOpen = 'open'
	const model = {
		tabs: [tab('parent'), tab('right')],
		focusedTabIndex: 0,
		recentTabs: ['parent'],
	}
	const c = ctx({ model })

	sessionTabs.apply([{ id: 'parent' } as any, { id: 'child' } as any, { id: 'right' } as any], '', c)
	sessionTabs.apply([{ id: 'parent' } as any, { id: 'right' } as any], '', c)

	expect(model.tabs[model.focusedTabIndex]?.sessionId).toBe('parent')
})

test('leaving a newly opened tab restores ordinary nearest-right close behavior', () => {
	sessionTabs.reset()
	sessionTabs.state.pendingOpen = 'open'
	const model = {
		tabs: [tab('parent'), tab('right')],
		focusedTabIndex: 0,
		recentTabs: ['parent'],
	}
	const c = ctx({ model })

	sessionTabs.apply([{ id: 'parent' } as any, { id: 'child' } as any, { id: 'right' } as any], '', c)
	sessionTabs.expireReturnTo('child')
	sessionTabs.apply([{ id: 'parent' } as any, { id: 'right' } as any], '', c)

	expect(model.tabs[model.focusedTabIndex]?.sessionId).toBe('right')
})
