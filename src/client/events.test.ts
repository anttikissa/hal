import { expect, test } from 'bun:test'
import { clientEvents } from './events.ts'

test('history-rebased reloads exactly the rebased log prefix', () => {
	const tab = { sessionId: 's1' }
	let reload: any = null
	let force: any = null

	clientEvents.handle({ type: 'history-rebased', sessionId: 's1', newLog: 'history8.asonl', entryCount: 6 }, {
		tabForSession: (sessionId: string) => sessionId === 's1' ? tab : null,
		reloadTabFromDisk: (receivedTab: any, opts: any) => { reload = { tab: receivedTab, opts } },
		onChange: (value: boolean) => { force = value },
	})

	expect(reload).toEqual({ tab, opts: { logName: 'history8.asonl', entryLimit: 6 } })
	expect(force).toBe(true)
})


test('history-updated reloads the authoritative current history', () => {
	const tab = { sessionId: 's1' }
	const calls: any[] = []
	clientEvents.handle({ type: 'history-updated', sessionId: 's1' }, {
		tabForSession: () => tab,
		reloadTabFromDisk: (...args: any[]) => calls.push(['reload', ...args]),
		onChange: (force: boolean) => calls.push(['change', force]),
	})
	expect(calls).toEqual([['reload', tab], ['change', true]])
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


test('background-activity updates summarizing state and done marker', () => {
	const calls: any[] = []
	clientEvents.handle({ type: 'background-activity', sessionId: 's1', activity: 'summarizing', active: false, done: true }, {
		setSummarizing: (sessionId: string, active: boolean) => calls.push(['summarizing', sessionId, active]),
		markWhatDone: (sessionId: string) => calls.push(['done', sessionId]),
	})

	expect(calls).toEqual([
		['summarizing', 's1', false],
		['done', 's1'],
	])
})
