import { describe, expect, test } from 'bun:test'
import { buildSummaryLine, formatMs, pickSlowest } from '../../scripts/test-parallel'

describe('test-parallel helpers', () => {
	test('pickSlowest sorts descending and limits results', () => {
		const slowest = pickSlowest(
			[
				{ file: 'a.test.ts', elapsedMs: 120 },
				{ file: 'b.test.ts', elapsedMs: 980 },
				{ file: 'c.test.ts', elapsedMs: 240 },
				{ file: 'd.test.ts', elapsedMs: 640 },
			],
			2,
		)
		expect(slowest).toEqual([
			{ file: 'b.test.ts', elapsedMs: 980 },
			{ file: 'd.test.ts', elapsedMs: 640 },
		])
	})

	test('formatMs rounds to whole milliseconds', () => {
		expect(formatMs(0)).toBe('0ms')
		expect(formatMs(12.4)).toBe('12ms')
		expect(formatMs(12.5)).toBe('13ms')
	})

	test('buildSummaryLine reports total elapsed milliseconds', () => {
		const line = buildSummaryLine({ totalPass: 10, totalFail: 0, failedFiles: 0, elapsedMs: 1234.4 })
		expect(line).toContain('10 pass, 0 fail')
		expect(line).toContain('all passed')
		expect(line).toContain('1234ms')
	})
})
