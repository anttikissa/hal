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
	expect(perf.trace()).toContain('(why)')
})
