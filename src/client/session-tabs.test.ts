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


test('background opened tab keeps new attention marker', () => {
	sessionTabs.reset()
	const model = {
		tabs: [tab('left')],
		focusedTabIndex: 0,
		recentTabs: ['left'],
	}
	const c = ctx({
		model,
		makeTabFromDisk: (item: any) => ({ ...tab(item.id), attention: item.attention }),
	})

	sessionTabs.apply([{ id: 'left' } as any, { id: 'new', attention: 'new' } as any], 'left', c)

	expect(model.focusedTabIndex).toBe(0)
	expect(model.tabs[1]?.attention).toBe('new')
})

test('focused newly opened tab clears new attention marker', () => {
	sessionTabs.reset()
	sessionTabs.state.pendingOpen = 'open'
	const model = {
		tabs: [tab('left')],
		focusedTabIndex: 0,
		recentTabs: ['left'],
	}
	const c = ctx({
		model,
		makeTabFromDisk: (item: any) => ({ ...tab(item.id), attention: item.attention }),
	})

	sessionTabs.apply([{ id: 'left' } as any, { id: 'new', attention: 'new' } as any], 'left', c)

	expect(model.focusedTabIndex).toBe(1)
	expect(model.tabs[1]?.attention).toBeUndefined()
})

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
