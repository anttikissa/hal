import { afterEach, expect, test } from 'bun:test'
import { clock } from './clock.ts'

const orig = { now: clock.now, sleep: clock.sleep }
let now = 0

afterEach(() => {
	Object.assign(clock, orig)
	clock.stop()
	clock.state.listeners.clear()
})

// An injected clock: sleeping just moves time forward.
function fake() {
	now = 1_000_000
	let slept: number[] = []
	clock.now = () => now
	clock.sleep = async (ms) => {
		slept.push(ms)
		now += ms
	}
	return slept
}

test('a tick that comes far too late is a wake; normal ticks are not', () => {
	fake()
	let wakes = 0
	clock.onWake(() => wakes++)
	clock.tick()
	now += clock.tickMs()
	clock.tick()
	now += clock.tickMs() + 100
	clock.tick()
	expect(wakes).toBe(0)
	now += 3600_000
	clock.tick()
	expect(wakes).toBe(1)
})

test('until waits in short slices, so a long wait never oversleeps a jump', async () => {
	let slept = fake()
	await clock.until(now + 10_500)
	expect(Math.max(...slept)).toBeLessThanOrEqual(clock.tickMs())
	expect(now).toBe(1_000_000 + 10_500)
	// Wall time jumped past the target (a sleep): no more waiting.
	slept.length = 0
	let at = now + 60_000
	now = at + 1
	await clock.until(at)
	expect(slept).toEqual([])
})

test('until ends early on a wake or an abort', async () => {
	fake()
	let start = now
	clock.sleep = async (ms) => {
		now += ms
		if (now - start >= 3000) clock.wake()
	}
	await clock.until(now + 3600_000)
	expect(now - start).toBe(3000)
	let ac = new AbortController()
	ac.abort()
	start = now
	await clock.until(now + 3600_000, ac.signal)
	expect(now).toBe(start)
})

test('the real sleep resolves on abort', async () => {
	let ac = new AbortController()
	let p = clock.sleep(60_000, ac.signal)
	ac.abort()
	await p
})
