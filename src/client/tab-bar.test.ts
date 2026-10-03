import { afterEach, expect, test } from 'bun:test'
import type { Tab } from '../common/protocol.ts'
import type { SessionState } from '../common/states.ts'
import { strings } from '../common/strings.ts'
import { ansi } from './ansi.ts'
import { tabBar } from './tab-bar.ts'

const saved: { mono?: () => boolean } = {}
afterEach(() => {
	if (saved.mono) ansi.mono = saved.mono
})

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

test('each tab shows at most one indicator for what it needs', () => {
	let list = [
		tab('a', { type: 'running', phase: 'streaming' }),
		tab('b', { type: 'running', phase: 'tools' }, true),
		tab('c', { type: 'blocked', reason: 'question' }, true),
		tab('d', { type: 'retrying', at: '', reason: 'x' }),
		tab('e', { type: 'error', message: 'x' }, true),
		tab('f', { type: 'paused' }),
		tab('g', { type: 'idle' }, true),
		tab('h', { type: 'idle' }),
	]
	expect(bar(list, 'h', 200)).toStartWith(' 1▪ 2◆ 3! 4✗ 5✗ 6! 7✓ 8  ')
})

// A tab's indicator as drawn: its glyph and SGR, lit or dark.
const mark = (state: SessionState, attention: boolean, lit: boolean) => {
	let row = tabBar.row([tab('x', state, attention)], 'y', 80, lit)
	return row.slice(row.indexOf('1\x1b]8;;\x07') + 7).split('\x1b[')[1]!
}

test('working and failing indicators blink; the others stay', () => {
	saved.mono = ansi.mono
	ansi.mono = () => false
	let blinking: [SessionState, boolean][] = [
		[{ type: 'running', phase: 'streaming' }, false],
		[{ type: 'running', phase: 'requesting' }, true],
		[{ type: 'retrying', at: '', reason: 'x' }, false],
		[{ type: 'error', message: 'x' }, false],
	]
	let steady: [SessionState, boolean][] = [
		[{ type: 'blocked', reason: 'question' }, false],
		[{ type: 'paused' }, false],
		[{ type: 'idle' }, true],
		[{ type: 'idle' }, false],
	]
	for (let [s, a] of blinking) {
		expect(mark(s, a, true)).not.toBe(mark(s, a, false))
		expect(tabBar.blinks([tab('a'), tab('x', s, a)])).toBe(true)
	}
	for (let [s, a] of steady) {
		expect(mark(s, a, true)).toBe(mark(s, a, false))
		expect(tabBar.blinks([tab('x', s, a)])).toBe(false)
	}
})

test('without colours a blinking indicator comes and goes', () => {
	saved.mono = ansi.mono
	ansi.mono = () => true
	let list = [tab('a', { type: 'running', phase: 'streaming' }), tab('b', { type: 'paused' })]
	expect(text(tabBar.row(list, 'b', 80, true))).toStartWith(' 1▪ 2! ')
	// The same width dark, so nothing after it moves.
	expect(text(tabBar.row(list, 'b', 80, false))).toStartWith(' 1  2! ')
	// The focused number is underlined even without colours.
	expect(tabBar.row(list, 'b', 80)).toContain('\x1b[4m\x1b]8;;')
})

test('the bar stays one row: hints go, then it pages', () => {
	let list = Array.from({ length: 12 }, (_, i) => tab(`t${i}`))
	list[0] = tab('t0', { type: 'error', message: 'x' })
	let seen: string[] = []
	for (let cols = 120; cols >= 16; cols--) {
		let row = bar(list, 't10', cols)
		expect(strings.visLen(row)).toBeLessThanOrEqual(cols - 1)
		if (seen.at(-1) !== row) seen.push(row)
	}
	// Lowest priority first: close, then switch, then goto; the numbers
	// last of all.
	let at = (s: string) => seen.findIndex((r) => !r.includes(s))
	expect(at('ctrl-w')).toBeLessThan(at('ctrl-n/p'))
	expect(at('ctrl-n/p')).toBeLessThan(at('alt-#'))
	expect(seen.some((r) => r.includes('Tabs:'))).toBe(false)
	// Every cell is 4 wide (two digits, marker, gap), none clipped.
	expect(seen).toContain('  1✗  2   3   4   5   6   7   8   9  10  11  12  ')
	// Paged: 7 per page in 36 columns, edges at both ends with no count.
	// The last page ends at tab 12 and is full; the left edge carries
	// tab 1's failure.
	expect(bar(list, 't10', 38)).toBe(' ‹✗  6   7   8   9  10  11  12     › ')
	expect(bar(list, 't0', 38)).toBe(' ‹   1✗  2   3   4   5   6   7     › ')
})
