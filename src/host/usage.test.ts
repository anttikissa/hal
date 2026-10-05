import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { clock } from './clock.ts'
import { paths } from './paths.ts'
import { usage } from './usage.ts'

const savedHome = process.env.HAL_HOME
const origNow = clock.now
let home = ''
let now = 1_800_000_000_000
const secs = (ms: number) => String(Math.floor(ms / 1000))
const at = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString()

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-usage-`)
	process.env.HAL_HOME = home
	paths.init()
	clock.now = () => now
})

afterEach(() => {
	usage.close()
	clock.now = origNow
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

test("Anthropic's unified headers are windows in percent with reset times", () => {
	let h = new Headers({
		'anthropic-ratelimit-unified-status': 'allowed',
		'anthropic-ratelimit-unified-5h-utilization': '0.07',
		'anthropic-ratelimit-unified-5h-reset': secs(now + 3600_000),
		'anthropic-ratelimit-unified-7d-utilization': '0.53',
		'anthropic-ratelimit-unified-7d-reset': secs(now + 86400_000),
		'anthropic-ratelimit-unified-reset': secs(now + 3600_000),
	})
	let w = usage.parse(h)
	expect(Object.keys(w).sort()).toEqual(['5h', '7d'])
	expect(w['5h']!.used).toBeCloseTo(7)
	expect(w['5h']!.resets).toBe(at(now + 3600_000))
	expect(w['7d']!.used).toBeCloseTo(53)
})

test("Codex's primary and secondary windows are named by their span", () => {
	let w = usage.parse(
		new Headers({
			'x-codex-primary-used-percent': '12',
			'x-codex-primary-window-minutes': '300',
			'x-codex-primary-reset-after-seconds': '600',
			'x-codex-secondary-used-percent': '100',
			'x-codex-secondary-window-minutes': '10080',
			'x-codex-secondary-reset-at': secs(now + 86400_000),
		}),
	)
	expect(w).toEqual({ '5h': { used: 12, resets: new Date(now + 600_000).toISOString() }, '7d': { used: 100, resets: at(now + 86400_000) } })
	expect(usage.parse(new Headers({ 'content-type': 'text/event-stream' }))).toEqual({})
})

test('rotation spends the week that resets soonest; nearly spent accounts come last; a reset window is over', () => {
	const h = 3600_000
	let obs = (account: string, u5: number, u7: number, r7: number) =>
		usage.observe(
			'anthropic',
			account,
			new Headers({
				'anthropic-ratelimit-unified-5h-utilization': String(u5),
				'anthropic-ratelimit-unified-5h-reset': secs(now + 3 * h),
				'anthropic-ratelimit-unified-7d-utilization': String(u7),
				'anthropic-ratelimit-unified-7d-reset': secs(now + r7),
			}),
		)
	obs('a', 0.51, 0.86, 7 * h)
	obs('b', 0.09, 0.81, 26 * h)
	obs('c', 0.96, 0.2, 120 * h) // 5h nearly spent
	obs('e', 0.1, 0.99, 2 * h) // week nearly spent
	obs('f', 0.1, 0.5, 72 * h)
	obs('g', 0.1, 0.1, 48 * h)
	let order = () => usage.order('anthropic', ['a', 'b', 'c', 'd', 'e'], (x) => x)
	// d has no data: eligible, but no known reset to spend first.
	expect(order()).toEqual(['a', 'b', 'd', 'c', 'e'])
	// Survives a restart.
	usage.close()
	expect(order()).toEqual(['a', 'b', 'd', 'c', 'e'])
	// A session leaves its account for one whose week resets within a
	// day and sooner, or when its own is nearly spent; otherwise it stays.
	expect(usage.keeps('anthropic', 'b', 'a')).toBe(false)
	expect(usage.keeps('anthropic', 'c', 'a')).toBe(false)
	expect(usage.keeps('anthropic', 'f', 'g')).toBe(true)
	expect(usage.keeps('anthropic', 'd', 'a')).toBe(false)
	// 8 hours on: a's and e's weeks and every 5h window are over.
	now += 8 * h
	expect(order()).toEqual(['b', 'c', 'a', 'd', 'e'])
	// Another provider's data is its own.
	expect(usage.order('openai', ['d', 'a'], (x) => x)).toEqual(['d', 'a'])
})

test('a Sonnet-only week does not steer another Claude model to a busier account', () => {
	usage.observe('anthropic', 'a', new Headers({
		'anthropic-ratelimit-unified-7d_sonnet-utilization': '0.99',
		'anthropic-ratelimit-unified-7d_sonnet-reset': secs(now + 86400_000),
		'anthropic-ratelimit-unified-5h-utilization': '0.1',
		'anthropic-ratelimit-unified-5h-reset': secs(now + 3600_000),
	}))
	usage.observe('anthropic', 'b', new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.4' }))
	expect(usage.order('anthropic', ['a', 'b'], (x) => x)).toEqual(['a', 'b'])
})
