import { expect, test } from 'bun:test'
import { strings } from '../common/strings.ts'
import { statusRow, type StatusInfo } from './status-row.ts'

const info: StatusInfo = {
	id: '156-way',
	name: 'Orchestrate v3',
	cwd: '/Users/me/hal2',
	home: '/Users/me',
	model: 'anthropic/claude-opus-5-5',
	role: 'host',
	stats: { context: 87_000, window: 1_000_000, sent: 252, received: 41_000, plan: { account: 1, accounts: 2, windows: { '5h': 18, '7d': 57 } } },
}

const text = (i: StatusInfo, cols: number) => statusRow.fit(i, cols).map((p) => p.text).join('')
const LEFT = '156-way: Orchestrate v3 · ~/hal2 · Opus 5.5 (default/unknown) · 87k/1000k (9%)'

test('a wide row shows every part, the right side flush right', () => {
	let row = text(info, 140)
	expect(row.startsWith(LEFT)).toBe(true)
	expect(row.endsWith('host · ↑252 ↓41k · Sub 1/2: 5h 18%, 7d 57%')).toBe(true)
	expect(strings.visLen(row)).toBe(140)
})

test('narrowing drops the plan, then the tokens, then the role, then clips the left', () => {
	let seen: string[] = []
	for (let cols = 140; cols > 10; cols--) {
		let row = text(info, cols)
		expect(strings.visLen(row)).toBeLessThanOrEqual(cols)
		let kind = row.includes('Sub') ? 'all' : row.includes('↑') ? 'tokens' : row.endsWith('host') ? 'role' : LEFT.startsWith(row.replace(/…$/, '')) ? 'left' : row
		if (seen.at(-1) !== kind) seen.push(kind)
	}
	expect(seen).toEqual(['all', 'tokens', 'role', 'left'])
	expect(text(info, 20)).toBe(`${LEFT.slice(0, 19)}…`)
})

test('the context is a heat-coloured percentage of the window', () => {
	let at = (context: number) => statusRow.left({ ...info, stats: { context, window: 200_000, sent: 0, received: 0 } }).at(-1)!
	let low = at(20_000)
	let high = at(190_000)
	expect(low.map((p) => p.text).join('')).toBe('20k/200k (10%)')
	expect(high.map((p) => p.text).join('')).toBe('190k/200k (95%)')
	// Hotter is redder: the hue falls from green towards red.
	expect(high[0]!.fg![2]).toBeLessThan(low[0]!.fg![2])
	// A new session: nothing used yet.
	expect(statusRow.left({ ...info, stats: { window: 200_000, sent: 0, received: 0 } }).at(-1)!.map((p) => p.text).join('')).toBe('0/200k (0%)')
})

test('token counts are compact', () => {
	expect([252, 999, 1000, 4100, 9_960, 41_000, 999_499, 999_600, 1_200_000, 12_000_000].map(statusRow.count)).toEqual(['252', '999', '1.0k', '4.1k', '10k', '41k', '999k', '1.0M', '1.2M', '12M'])
})

test('the painted row fits the terminal and ends its colour', () => {
	let row = statusRow.row(info, 60)
	expect(strings.visLen(row)).toBeLessThanOrEqual(60)
	expect(row.endsWith('\x1b[39;49m')).toBe(true)
})
