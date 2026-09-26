import { expect, test } from 'bun:test'
import { oklch } from './oklch.ts'

test('the ends of the lightness scale are black and white', () => {
	expect(oklch.toRgb([0, 0, 0])).toEqual([0, 0, 0])
	expect(oklch.toRgb([1, 0, 123])).toEqual([255, 255, 255])
	expect(oklch.toHex([1, 0, 0])).toBe('#ffffff')
})

test('zero chroma is grey whatever the hue', () => {
	let [r, g, b] = oklch.toRgb([0.6, 0, 250])
	expect(r).toBe(g)
	expect(g).toBe(b)
	expect(oklch.toRgb([0.6, 0, 25])).toEqual([r, g, b])
})

test('hues land where expected: 25 red, 145 green, 250 blue', () => {
	let [r1, g1, b1] = oklch.toRgb([0.65, 0.15, 25])
	expect(r1).toBeGreaterThan(g1)
	expect(r1).toBeGreaterThan(b1)
	let [r2, g2, b2] = oklch.toRgb([0.65, 0.15, 145])
	expect(g2).toBeGreaterThan(r2)
	expect(g2).toBeGreaterThan(b2)
	let [r3, g3, b3] = oklch.toRgb([0.65, 0.15, 250])
	expect(b3).toBeGreaterThan(r3)
	expect(b3).toBeGreaterThan(g3)
})

test('colours outside sRGB lose chroma, not hue or lightness', () => {
	let wild = oklch.toRgb([0.7, 0.5, 25])
	for (let c of wild) {
		expect(Number.isInteger(c)).toBe(true)
		expect(c).toBeGreaterThanOrEqual(0)
		expect(c).toBeLessThanOrEqual(255)
	}
	// Still red, and not clipped to pure primaries.
	expect(wild[0]).toBeGreaterThan(wild[1])
	expect(wild[1]).toBeGreaterThan(0)
	// Same lightness: about as bright as a grey of the same L.
	let grey = oklch.toRgb([0.7, 0, 0])[0]
	let luma = 0.2126 * wild[0] + 0.7152 * wild[1] + 0.0722 * wild[2]
	expect(Math.abs(luma - grey)).toBeLessThan(40)
})
