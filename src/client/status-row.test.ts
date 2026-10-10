import { afterEach, beforeEach, expect, test } from 'bun:test'
import { subscriptions } from '../common/subscriptions.ts'
import { titles } from '../common/titles.ts'
import { strings } from '../common/strings.ts'
import { statusRow, type StatusInfo } from './status-row.ts'

let originalNames: Record<string, string>
beforeEach(() => { subscriptions.apply({ test: { '5h': { used: 18 }, '7d': { used: 57 } } }); originalNames = titles.names; titles.names = { 'anthropic/claude-opus-5-5': 'Claude Opus 5.5' } })
afterEach(() => { titles.names = originalNames })

const info: StatusInfo = {
	id: '156-way',
	name: 'Orchestrate v3',
	cwd: '/Users/me/project',
	home: '/Users/me',
	model: 'anthropic/claude-opus-5-5',
	role: 'host',
	stats: { effort: 'high', context: 87_000, window: 1_000_000, plan: { account: 1, accounts: 2, key: 'test' } },
}

const text = (i: StatusInfo, cols: number) => statusRow.fit(i, cols).map((p) => p.text).join('')
const LEFT = '156-way: Orchestrate v3 · ~/project · Claude Opus 5.5 high b3 · 87k/1000k (9%)'

test('a wide row shows every part, the right side flush right', () => {
	let row = text(info, 140)
	expect(row.startsWith(LEFT)).toBe(true)
	expect(row.endsWith('host · Sub 1/2: 5h 18%, 7d 57%')).toBe(true)
	expect(strings.visLen(row)).toBe(140)
})

test('narrowing drops secondary facts but preserves the linked budget beside the model', () => {
	for (let cols = 140; cols > 10; cols--) {
		let parts = statusRow.fit({ ...info, slots: 12 }, cols)
		let row = parts.map((p) => p.text).join('')
		expect(strings.visLen(row)).toBeLessThanOrEqual(cols)
		expect(row).toContain(' b12')
		expect(parts.find((p) => p.text === ' b12')?.href).toBe('/budget')
	}
	expect(text(info, 20)).not.toContain('host')
})

test('the context is a heat-colored percentage of the window', () => {
	let at = (context: number) => statusRow.left({ ...info, stats: { context, window: 200_000 } }).at(-1)!
	let low = at(20_000)
	let high = at(190_000)
	expect(low.map((p) => p.text).join('')).toBe('20k/200k (10%)')
	expect(high.map((p) => p.text).join('')).toBe('190k/200k (95%)')
	// Hotter is redder: the hue falls from green towards red.
	expect(high[0]!.fg![2]).toBeLessThan(low[0]!.fg![2])
	// A new session: nothing used yet.
	expect(statusRow.left({ ...info, stats: { window: 200_000 } }).at(-1)!.map((p) => p.text).join('')).toBe('0/200k (0%)')
})

test('the painted row fits the terminal and ends its color', () => {
	let row = statusRow.row(info, 60)
	expect(strings.visLen(row)).toBeLessThanOrEqual(60)
	expect(row.endsWith('\x1b[39;49m')).toBe(true)
})
