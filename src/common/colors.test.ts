import { expect, test } from 'bun:test'
import { colors } from './colors.ts'

test('every style is a set of OKLCH colours', () => {
	for (let [key, value] of Object.entries(colors)) {
		if (typeof value !== 'function') continue
		let style = value()
		expect(Object.keys(style).length, key).toBeGreaterThan(0)
		for (let c of Object.values(style)) {
			expect(c).toHaveLength(3)
			expect(c[0]).toBeGreaterThanOrEqual(0)
			expect(c[0]).toBeLessThanOrEqual(1)
		}
	}
})

test('overriding a shared value moves every style derived from it, at call time', () => {
	let saved = colors.fgL
	try {
		let before = { assistant: colors.assistant().fg, bash: colors.toolBash().fg, grep: colors.toolGrep().fg }
		colors.fgL = 0.9
		expect(colors.assistant().fg![0]).toBe(0.9)
		expect(colors.toolBash().fg![0]).toBe(0.9)
		expect(colors.toolGrep().fg).toEqual(colors.toolRead().fg!)
		expect(colors.assistant().fg).not.toEqual(before.assistant!)
		expect(colors.toolGrep().fg).not.toEqual(before.grep!)
	} finally {
		colors.fgL = saved
	}
})

test('overriding one style is seen by styles built on it', () => {
	let saved = colors.toolRead
	try {
		colors.toolRead = () => ({ fg: [0.5, 0.1, 10] })
		expect(colors.toolLs().fg).toEqual([0.5, 0.1, 10])
	} finally {
		colors.toolRead = saved
	}
})
