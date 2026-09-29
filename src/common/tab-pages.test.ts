import { expect, test } from 'bun:test'
import type { Tab } from './protocol.ts'
import type { SessionState } from './states.ts'
import { tabPages } from './tab-pages.ts'

const tab = (state: SessionState = { type: 'idle' }, attention = false): Tab => ({
	id: 'x',
	name: 'x',
	cwd: '/',
	model: 'm',
	state,
	...(attention ? { attention: true as const } : {}),
})
const tabs = (n: number) => Array.from({ length: n }, () => tab())
const sizes = { cell: 4, named: 15, edge: 5 }

test('names only when every tab fits with one, then numbers, then pages', () => {
	expect(tabPages.page(tabs(4), 0, 60, sizes)).toEqual({ names: true, start: 0, end: 4 })
	expect(tabPages.page(tabs(4), 0, 59, sizes)).toEqual({ names: false, start: 0, end: 4 })
	expect(tabPages.page(tabs(4), 0, 16, sizes)).toEqual({ names: false, start: 0, end: 4 })
	expect(tabPages.page(tabs(4), 3, 15, sizes).left).toBeDefined()
})

test('pages are fixed: the one holding the current tab, whatever came before', () => {
	let list = tabs(23)
	// (40 - 2 * 5) / 4 = 7 per page: 1..7, 8..14, 15..21, 22..23.
	let seen = list.map((_, i) => tabPages.page(list, i, 40, sizes))
	seen.forEach((p, i) => {
		expect(p.start).toBe(Math.floor(i / 7) * 7)
		expect(p.end).toBe(Math.min(23, p.start + 7))
		expect(p.left!.count + (p.end - p.start) + p.right!.count).toBe(23)
	})
	expect(seen[22]).toMatchObject({ start: 21, end: 23, right: { count: 0 } })
	// A width too small for one cell still shows the current tab.
	expect(tabPages.page(list, 5, 3, sizes)).toMatchObject({ start: 5, end: 6 })
})

test('an edge carries its side’s most urgent mark; finished ones do not count', () => {
	let urgent = (...states: [SessionState, boolean][]) => tabPages.urgent(states.map(([s, a]) => tab(s, a)))?.kind
	let working: [SessionState, boolean] = [{ type: 'running', phase: 'streaming' }, false]
	let noticed: [SessionState, boolean] = [{ type: 'running', phase: 'streaming' }, true]
	let asking: [SessionState, boolean] = [{ type: 'blocked', reason: 'question' }, false]
	let failed: [SessionState, boolean] = [{ type: 'error', message: 'x' }, true]
	let done: [SessionState, boolean] = [{ type: 'idle' }, true]
	expect(urgent(done)).toBeUndefined()
	expect(urgent(done, working)).toBe('working')
	expect(urgent(working, noticed, working)).toBe('noticed')
	expect(urgent(noticed, asking)).toBe('asking')
	expect(urgent(asking, failed, noticed)).toBe('failed')
	let list = [tab(...failed), ...tabs(20)]
	expect(tabPages.page(list, 20, 40, sizes).left?.mark?.kind).toBe('failed')
})
