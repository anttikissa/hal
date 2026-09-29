import { expect, test } from 'bun:test'
import { tabs, type Focus } from './tabs.ts'

// Plays a sequence of tab lists through the focus rules.
const at = (f: Focus) => f.tab

test('a tab this client asked for gets focus, remembering where it came from', () => {
	let f = tabs.focus(['a', 'b'], ['a', 'n', 'b'], { tab: 'a' })
	// The list arrives before the ack: another client's tab, for all we know.
	expect(at(f)).toBe('a')
	f = tabs.focus(['a', 'n', 'b'], ['a', 'n', 'b'], f, 'n')
	expect(f).toEqual({ tab: 'n', opener: { tab: 'n', from: 'a' } })
	// An ack for a tab not in the list yet changes nothing.
	expect(tabs.focus(['a'], ['a'], { tab: 'a' }, 'later')).toEqual({ tab: 'a' })
})

test('closing a tab opened here goes back to its opener', () => {
	let f: Focus = { tab: 'n', opener: { tab: 'n', from: 'a' } }
	expect(tabs.focus(['a', 'n', 'b'], ['a', 'b'], f)).toEqual({ tab: 'a' })
	// Opener gone too: the right neighbour.
	expect(tabs.focus(['a', 'n', 'b'], ['b'], f)).toEqual({ tab: 'b' })
})

test('an opener expires once focus has left the new tab', () => {
	// Went n → b → n: the focus the app sets on a switch has no opener.
	let f: Focus = { tab: 'n' }
	expect(tabs.focus(['a', 'n', 'b'], ['a', 'b'], f)).toEqual({ tab: 'b' })
	// A stale opener naming another tab is ignored as well.
	expect(tabs.focus(['a', 'n', 'b'], ['a', 'b'], { tab: 'n', opener: { tab: 'x', from: 'a' } })).toEqual({ tab: 'b' })
})

test('closing the focused tab goes right, or to the new last tab', () => {
	expect(at(tabs.focus(['a', 'b', 'c'], ['a', 'c'], { tab: 'b' }))).toBe('c')
	expect(at(tabs.focus(['a', 'b', 'c'], ['a', 'b'], { tab: 'c' }))).toBe('b')
	// Its right neighbour closed at the same time: the next one still open.
	expect(at(tabs.focus(['a', 'b', 'c', 'd'], ['a', 'd'], { tab: 'b' }))).toBe('d')
})

test("other clients' tabs never move focus", () => {
	let f: Focus = { tab: 'b', opener: { tab: 'b', from: 'a' } }
	// Opened, moved, closed elsewhere: focus and opener stay.
	expect(tabs.focus(['a', 'b'], ['a', 'b', 'x'], f)).toBe(f)
	expect(tabs.focus(['a', 'b', 'x'], ['x', 'b', 'a'], f)).toBe(f)
	expect(tabs.focus(['a', 'b', 'x'], ['b', 'x'], f)).toBe(f)
	// No focus yet (waiting for the start ack): none is made up.
	expect(tabs.focus([], ['a', 'b'], {})).toEqual({})
	// Re-acking the focused tab (a reconnect) keeps the opener.
	expect(tabs.focus(['a', 'b'], ['a', 'b'], f, 'b')).toBe(f)
})

