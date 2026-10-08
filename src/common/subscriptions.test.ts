import { expect, test } from 'bun:test'
import { subscriptions } from './subscriptions.ts'
import { protocol } from './protocol.ts'

test('master usage preserves account/window identity, replaces omitted data, and isolates accounts', () => {
	let before = subscriptions.state
	subscriptions.state = {}
	try {
		subscriptions.apply({ a: { '5h': { used: 51, resets: '2099-01-01T00:00:00Z' }, '7d': { used: 40 } }, b: { '5h': { used: 95 } } })
		let account = subscriptions.state.a, window = account!['5h']
		subscriptions.apply({ a: { '5h': { used: 52 } } })
		expect(subscriptions.state.a).toBe(account)
		expect(subscriptions.state.a!['5h']).toBe(window)
		expect(subscriptions.plan({ account: 1, accounts: 2, key: 'a' })).toEqual({ windows: { '5h': 52 }, resets: {} })
		expect(subscriptions.state.b!['5h']!.used).toBe(95)
		subscriptions.apply({ b: { '5h': { used: 0 } } }, true)
		expect(subscriptions.plan({ account: 1, accounts: 2, key: 'a' }).windows).toEqual({})
	} finally { subscriptions.state = before }
})

test('quota events reject invalid nested readings before they reach the master store', () => {
	for (let window of [{ used: NaN }, { used: 101 }, { used: -1 }, { used: '52' }, { used: 52, resets: 'bad' }]) {
		expect(protocol.invalidEvent({ type: 'subscription-usage', accounts: { a: { '5h': window } } })).toBe('subscription-usage: invalid windows')
	}
	expect(protocol.invalidEvent({ type: 'subscription-usage', accounts: JSON.parse('{"__proto__": {"5h": {"used": 0}}}') })).toBe('subscription-usage: invalid windows')
	expect(protocol.invalidEvent({ type: 'tabs', tabs: [], accounts: {}, subscriptions: { a: { '5h': { used: 'bad' } } } })).toBe('tabs: invalid windows')
	expect(protocol.invalidEvent({ type: 'subscription-usage', accounts: { a: { '5h': { used: 0 } } } })).toBeUndefined()
})
