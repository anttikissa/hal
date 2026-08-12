import { expect, test } from 'bun:test'
import { web } from './web.ts'

test('web fallback port advances by a randomized exponential step', () => {
	expect(web.nextPort(9001, 1, () => 0)).toBe(9002)
	expect(web.nextPort(9001, 1, () => 0.99)).toBe(9003)
	expect(web.nextPort(9003, 2, () => 0)).toBe(9004)
})
