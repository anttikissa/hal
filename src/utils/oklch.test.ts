import { test, expect } from 'bun:test'
import { oklch } from './oklch.ts'

test('black', () => {
	expect(oklch.oklchToRgb(0, 0, 0)).toEqual([0, 0, 0])
})

test('white', () => {
	expect(oklch.oklchToRgb(1, 0, 0)).toEqual([255, 255, 255])
})

test('mid-grey has no chroma', () => {
	const [r, g, b] = oklch.oklchToRgb(0.5, 0, 0)
	// All channels equal for achromatic
	expect(r).toBe(g)
	expect(g).toBe(b)
	expect(r).toBeGreaterThan(50)
	expect(r).toBeLessThan(150)
})

test('orange hue produces warm color', () => {
	const [r, g, b] = oklch.oklchToRgb(0.75, 0.15, 70)
	// Orange: red > green > blue
	expect(r).toBeGreaterThan(g)
	expect(g).toBeGreaterThan(b)
})

test('toFg produces ANSI foreground escape', () => {
	const esc = oklch.toFg(0.5, 0, 0)
	expect(esc).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/)
})

test('toBg produces ANSI background escape', () => {
	const esc = oklch.toBg(0.5, 0, 0)
	expect(esc).toMatch(/^\x1b\[48;2;\d+;\d+;\d+m$/)
})

test('clamps out-of-gamut values', () => {
	// Very high chroma at extreme hue can go out of gamut
	const [r, g, b] = oklch.oklchToRgb(0.5, 0.4, 300)
	expect(r).toBeGreaterThanOrEqual(0)
	expect(r).toBeLessThanOrEqual(255)
	expect(g).toBeGreaterThanOrEqual(0)
	expect(g).toBeLessThanOrEqual(255)
	expect(b).toBeGreaterThanOrEqual(0)
	expect(b).toBeLessThanOrEqual(255)
})
