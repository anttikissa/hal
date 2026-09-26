import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { clock } from './clock.ts'
import { limits } from './limits.ts'
import { paths } from './paths.ts'

const savedHome = process.env.HAL_HOME
const origNow = clock.now
let home = ''
let now = 1_800_000_000_000

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-limits-`)
	process.env.HAL_HOME = home
	paths.init()
	clock.now = () => now
})

afterEach(() => {
	limits.close()
	clock.now = origNow
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

test('a limit holds until its time, per model and account, and survives a restart', () => {
	let a = limits.key('anthropic/claude-x', 'a@example.com')
	let b = limits.key('anthropic/claude-x', 'b@example.com')
	limits.set(a, now + 3 * 3600_000)
	expect(limits.until(a)).toBe(now + 3 * 3600_000)
	expect(limits.until(b)).toBe(0)
	expect(limits.until(limits.key('anthropic/claude-y', 'a@example.com'))).toBe(0)
	// A new host reads it back from state/.
	limits.close()
	expect(limits.until(a)).toBe(now + 3 * 3600_000)
	now += 3 * 3600_000
	expect(limits.until(a)).toBe(0)
})

test('limits already over are forgotten', () => {
	limits.set('m1', now + 1000)
	now += 2000
	limits.set('m2', now + 1000)
	expect(Object.keys(limits.store())).toEqual(['m2'])
})
