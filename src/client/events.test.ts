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
