import { expect, test } from 'bun:test'
import type { Tab } from '../common/protocol.ts'
import type { SessionState } from '../common/states.ts'
import { strings } from '../common/strings.ts'
import { tabBar } from './tab-bar.ts'

const tab = (id: string, state: SessionState = { type: 'idle' }, attention = false): Tab => ({
	id,
	name: id,
	cwd: '/',
	model: 'm',
	state,
	...(attention ? { attention: true as const } : {}),
})
const text = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, '')
const bar = (list: Tab[], focused: string, cols: number) => text(tabBar.row(list, focused, cols))

test('one tab shows creation hints, several show navigation hints', () => {
	expect(bar([tab('a')], 'a', 80)).toBe(' Tabs: [1]  ctrl-t: new')
	let wide = bar([tab('a'), tab('b'), tab('c')], 'b', 80)
	expect(wide).toStartWith(' Tabs:  1 [2] 3 ')
	expect(wide).toContain('alt-#: goto')
	expect(wide).toContain('ctrl-n/p: switch')
	expect(wide).not.toContain('ctrl-t')
})

test('each tab shows at most one indicator for what it needs', () => {
	let list = [
		tab('a', { type: 'running', phase: 'streaming' }, true),
		tab('b', { type: 'blocked', reason: 'question' }),
		tab('c', { type: 'error', message: 'x' }, true),
		tab('d', { type: 'idle' }, true),
		tab('e', { type: 'paused' }),
	]
	expect(bar(list, 'e', 200)).toStartWith(' Tabs:  1▪  2!  3✗  4◆ [5] ')
})

test('the bar stays one row, dropping hints, then the label, then padding', () => {
	let list = [tab('a'), tab('b'), tab('c')]
	let seen: string[] = []
	for (let cols = 80; cols >= 3; cols--) {
		let row = bar(list, 'a', cols)
		expect(strings.visLen(row)).toBeLessThanOrEqual(cols - 1)
		if (seen.at(-1) !== row) seen.push(row)
	}
	// Lowest priority first: close, then switch, then goto; the numbers
	// last of all.
	let at = (s: string) => seen.findIndex((r) => !r.includes(s))
	expect(at('ctrl-w')).toBeLessThan(at('ctrl-n/p'))
	expect(at('ctrl-n/p')).toBeLessThan(at('alt-#'))
	expect(at('alt-#')).toBeLessThan(at('Tabs:'))
	expect(seen).toContain(' [1] 2  3 ')
	expect(seen).toContain(' [1] 2 3')
	// Every tab stays visible for as long as it can.
	for (let row of seen.filter((r) => strings.visLen(r) >= 9)) expect(row).toMatch(/1.*2.*3/)
})
