import { afterEach, beforeEach, expect, test } from 'bun:test'
import { titles } from '../common/titles.ts'
import type { Event, Stats } from '../common/protocol.ts'
import { status } from './status.ts'
import { view, type ViewState } from './view.ts'

let originalNames: Record<string, string>
beforeEach(() => { originalNames = titles.names; titles.names = {} })
afterEach(() => { titles.names = originalNames })

const meta = { id: '1-abc', cwd: '/w', model: 'fake/m', createdAt: '2026-09-26T00:00:00Z' }
const sessionId = meta.id
const fold = (events: Event[], st: ViewState = {}) => events.reduce(view.onEvent, st)
const withStats = (stats: Stats) => fold([{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' }, stats } }])

test('details show all session facts and heat percentages from pushed Stats, including refreshed turn-end data', () => {
	let st = fold([{ type: 'snapshot', sessionId, snapshot: {
		meta: { ...meta, name: 'Work', cwd: '/w/project', model: 'anthropic/claude-opus-5-5' }, history: [], state: { type: 'idle' },
		stats: { context: 87000, window: 1000000, sent: 252, received: 41000, plan: { account: 2, accounts: 3, windows: { '5h': 18, '7d': 92 } } },
	} }])
	expect(status.groups(st)[2]?.parts[0]?.text).toBe('anthropic/claude-opus-5-5')
	st = view.onEvent(st, { type: 'model-names', names: { 'anthropic/claude-opus-5-5': 'Claude Opus 5.5' } })
	let groups = status.groups(st)
	expect(groups.map((g) => g.parts.map((p) => p.text).join(''))).toEqual([
		'1-abc: Work', '/w/project', 'Claude Opus 5.5', '87k/1000k (9%)', '↑252 ↓41k', 'Sub 2/3: 5h 18%, 7d 92%',
	])
	expect(groups.flatMap((g) => g.parts).filter((p) => p.heat !== undefined)).toEqual([
		{ text: '9%', heat: 9 }, { text: '18%', heat: 18 }, { text: '92%', heat: 92 },
	])
	st = view.onEvent(st, { type: 'turn-end', sessionId, status: 'completed', stats: { context: 810000, window: 1000000, sent: 1000, received: 10 } })
	expect(status.groups(st).flatMap((g) => g.parts).find((p) => p.text === '81%')).toEqual({ text: '81%', heat: 81 })
})

test('the model name fills by the shortest window, not the most used, ignoring model-specific ones', () => {
	let plan = { account: 1, accounts: 1, windows: { '7d': 95, '7d_sonnet': 99, '5h': 30 }, resets: { '5h': '2026-09-26T05:00:00Z' } }
	expect(status.quota(withStats({ sent: 0, received: 0, plan }))).toEqual({ window: '5h', used: 30, remaining: 70 })
	expect(status.windows(withStats({ sent: 0, received: 0, plan }))).toEqual([{ name: '5h', used: 30, resets: '2026-09-26T05:00:00Z' }, { name: '7d', used: 95 }])
})

test('a full 7d hides the 5h, and the name fills by the 7d', () => {
	let plan = { account: 1, accounts: 1, windows: { '5h': 12, '7d': 100 }, resets: { '5h': '2026-10-02T10:10:00Z', '7d': '2026-10-05T21:00:00Z' } }
	expect(status.windows(withStats({ sent: 0, received: 0, plan })).map((w) => w.name)).toEqual(['7d'])
	expect(status.quota(withStats({ sent: 0, received: 0, plan }))).toEqual({ window: '7d', used: 100, remaining: 0 })
	// A full 5h that resets first leaves the 7d in play.
	let short = { ...plan, windows: { '5h': 100, '7d': 40 } }
	expect(status.windows(withStats({ sent: 0, received: 0, plan: short })).map((w) => w.name)).toEqual(['5h', '7d'])
})

test('without quota data the name stays neutral and no windows show', () => {
	let none = withStats({ sent: 0, received: 0 })
	expect(status.quota(none)).toBeUndefined()
	expect(status.windows(none)).toEqual([])
	expect(status.quota(withStats({ sent: 0, received: 0, plan: { account: 1, accounts: 1, windows: {} } }))).toBeUndefined()
})
