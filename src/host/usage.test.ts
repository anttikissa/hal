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

test('least used first: tightest window, then sooner reset; no data is unused; a reset window is over', () => {
	let obs = (account: string, u5: number, r5: number, u7: number) =>
		usage.observe(
			'anthropic',
			account,
			new Headers({
				'anthropic-ratelimit-unified-5h-utilization': String(u5),
				'anthropic-ratelimit-unified-5h-reset': secs(now + r5),
				'anthropic-ratelimit-unified-7d-utilization': String(u7),
				'anthropic-ratelimit-unified-7d-reset': secs(now + 5 * 86400_000),
			}),
		)
	// a: 7d 80% is its tightest; b: 5h 60%; c: 60% too but resets sooner.
	obs('a', 0.1, 3600_000, 0.8)
	obs('b', 0.6, 3 * 3600_000, 0.2)
	obs('c', 0.6, 3600_000, 0.2)
	let order = () => usage.order('anthropic', ['a', 'b', 'c', 'd'], (x) => x)
	expect(order()).toEqual(['d', 'c', 'b', 'a'])
	// Survives a restart.
	usage.close()
	expect(order()).toEqual(['d', 'c', 'b', 'a'])
	// b's and c's 5h windows are over: both at 7d 20%, a tie kept in order.
	now += 4 * 3600_000
	expect(order()).toEqual(['d', 'b', 'c', 'a'])
	// Another provider's data is its own.
	expect(usage.order('openai', ['a', 'd'], (x) => x)).toEqual(['a', 'd'])
})
