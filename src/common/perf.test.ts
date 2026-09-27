import { afterEach, expect, test } from 'bun:test'
import { perf } from './perf.ts'

let saved = { ...perf.state }
afterEach(() => Object.assign(perf.state, saved, { marks: [] }))

test('marks count from the epoch, so they include time before the process', () => {
	perf.state.epoch = perf.now() - 50
	perf.state.marks = []
	perf.mark('a')
	perf.mark('b', 'why')
	let [a, b] = perf.state.marks
	expect(a!.ms).toBeGreaterThanOrEqual(50)
	expect(b!.ms).toBeGreaterThanOrEqual(a!.ms)
	let lines = perf.trace().split('\n')
	expect(lines).toHaveLength(2)
	expect(lines[0]).toMatch(/^\s*\d+ms .* a \+\d+ms$/)
	expect(lines[1]).toContain('b')
	expect(lines[1]).toContain('(why)')
})
