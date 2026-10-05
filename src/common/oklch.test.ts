import { expect, test } from 'bun:test'
import { oklch } from './oklch.ts'

test('the ends of the lightness scale are black and white', () => {
	expect(oklch.toRgb([0, 0, 0])).toEqual([0, 0, 0])
	expect(oklch.toRgb([1, 0, 123])).toEqual([255, 255, 255])
	expect(oklch.toHex([1, 0, 0])).toBe('#ffffff')
})

test('zero chroma is gray whatever the hue', () => {
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

test('colors outside sRGB darken to keep their chroma and hue', () => {
	// A bright orange no sRGB color holds at its lightness: it stays
	// vivid orange by darkening, never fading to peach.
	let [L, C, h] = oklch.fit([0.84, 0.19, 55])
	expect(h).toBe(55)
	expect(L).toBeLessThan(0.84)
	expect(C).toBeGreaterThan(0.17)
	let [r, g, b] = oklch.toRgb([0.84, 0.19, 55])
	expect(r).toBe(255)
	expect(b).toBeLessThan(40)
	expect(g).toBeGreaterThan(b)
	// One that fits once darker keeps its chroma exactly.
	expect(oklch.fit([0.8, 0.15, 55])[1]).toBe(0.15)
	// In gamut: untouched.
	expect(oklch.fit([0.7, 0.05, 55])).toEqual([0.7, 0.05, 55])
	// A dark one (a card background) keeps its lightness and loses chroma.
	let bg = oklch.fit([0.21, 0.06, 215])
	expect(bg[0]).toBe(0.21)
	expect(bg[1]).toBeLessThan(0.06)
	// Impossible chroma: still red, integers in range.
	let wild = oklch.toRgb([0.7, 0.5, 25])
	for (let c of wild) {
		expect(Number.isInteger(c)).toBe(true)
		expect(c).toBeGreaterThanOrEqual(0)
		expect(c).toBeLessThanOrEqual(255)
	}
	expect(wild[0]).toBeGreaterThan(wild[1])
})
