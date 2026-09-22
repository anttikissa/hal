import { expect, test } from 'bun:test'
import { clientEvents } from './events.ts'

test('history-rebased reloads exactly the rebased log prefix', () => {
	const tab = { sessionId: 's1' }
	let reload: any = null
	let force: any = null

	clientEvents.handle({ type: 'history-rebased', sessionId: 's1', newLog: 'history8.asonl', entryCount: 6 }, {
		tabForSession: (sessionId: string) => sessionId === 's1' ? tab : null,
		reloadTabFromDisk: (receivedTab: any, opts: any) => { reload = { tab: receivedTab, opts } },
		repaintIfActive: (_tab: any, value: boolean) => { force = value },
	})

	expect(reload).toEqual({ tab, opts: { logName: 'history8.asonl', entryLimit: 6 } })
	expect(force).toBe(true)
})

test('history-updated force-repaints only the active tab', () => {
	const tab = { sessionId: 's1' }
	const calls: any[] = []
	clientEvents.handle({ type: 'history-updated', sessionId: 's1' }, {
		tabForSession: () => tab,
		currentTab: () => tab,
		reloadTabFromDisk: (...args: any[]) => calls.push(['reload', ...args]),
		onChange: (force: boolean) => calls.push(['change', force]),
	})
	expect(calls).toEqual([['reload', tab, { includeLive: false }], ['change', true]])
})

test('background history update redraws its tab marker without a force repaint', () => {
	const active = { sessionId: 's4' }
	const background = { sessionId: 's5' }
	const calls: any[] = []
	clientEvents.handle({ type: 'history-updated', sessionId: 's5' }, {
		tabForSession: () => background,
		currentTab: () => active,
		reloadTabFromDisk: (...args: any[]) => calls.push(['reload', ...args]),
		onChange: (force: boolean) => calls.push(['change', force]),
	})
	expect(calls).toEqual([['reload', background, { includeLive: false }], ['change', false]])
})

test('reconnect refreshes every tab but repaints only the active tab', () => {
	const tabs = Array.from({ length: 5 }, (_, index) => ({ sessionId: `s${index + 1}` }))
	const reloads: string[] = []
	const repaints: Array<{ sessionId: string; force: boolean }> = []
	const ctx = {
		tabForSession: (sessionId: string) => tabs.find((tab) => tab.sessionId === sessionId),
		reloadTabFromDisk: (tab: any) => reloads.push(tab.sessionId),
		repaintIfActive: (tab: any, force: boolean) => {
			if (tab === tabs[0]) repaints.push({ sessionId: tab.sessionId, force })
		},
	}

	for (const tab of tabs) clientEvents.handle({ type: 'history-rebased', sessionId: tab.sessionId }, ctx)

	expect(reloads).toEqual(['s1', 's2', 's3', 's4', 's5'])
	expect(repaints).toEqual([{ sessionId: 's1', force: true }])
})

test('prompt event keeps actual text behind display text', () => {
	let block: any = null
	const cleared: string[] = []
	clientEvents.handle({ type: 'prompt', sessionId: 's1', text: 'Ask:\n\n[/tmp/hal/paste/0002.txt]', actualText: 'Ask:\n\nfull paste' }, {
		flushDelayedPaused: () => {},
		addBlockToTab: (_sessionId: string, value: any) => { block = value },
		clearPendingPrompt: (sessionId: string) => { cleared.push(sessionId) }
	})

	expect(block).toMatchObject({
		type: 'user',
		text: 'Ask:\n\n[/tmp/hal/paste/0002.txt]',
		actualText: 'Ask:\n\nfull paste',
	})
	expect(cleared).toEqual(['s1'])
})

test('prompt events add remote local-user prompts to up-arrow history', () => {
	const recalls: Array<{ sessionId: string; text: string }> = []
	clientEvents.handle({ type: 'prompt', id: 'prompt-1', sessionId: 's1', text: '[...paste]', actualText: 'full prompt' }, {
		flushDelayedPaused: () => {},
		addBlockToTab: () => {},
		appendInputHistory: (sessionId: string, text: string) => recalls.push({ sessionId, text }),
		clearPendingPrompt: () => {},
	})
	clientEvents.handle({ type: 'prompt', id: 'prompt-2', sessionId: 's1', text: 'handoff', source: 'other-tab' }, {
		flushDelayedPaused: () => {},
		addBlockToTab: () => {},
		appendInputHistory: (sessionId: string, text: string) => recalls.push({ sessionId, text }),
		clearPendingPrompt: () => {},
	})

	expect(recalls).toEqual([{ sessionId: 's1', text: 'full prompt' }])
})

test('runtime-start from promoted client is not described as restart', () => {
	let restart: any = null
	let promotion: any = null

	clientEvents.handle({ type: 'runtime-start', pid: 123, reason: 'promote', startedAt: '2026-06-04T12:00:00.000Z' }, {
		pid: 456,
		showServerRestart: (pid: number, startedAt?: string) => { restart = { pid, startedAt } },
		showServerPromotion: (pid: number, startedAt?: string) => { promotion = { pid, startedAt } },
	})

	expect(restart).toBeNull()
	expect(promotion).toEqual({ pid: 123, startedAt: '2026-06-04T12:00:00.000Z' })
})
