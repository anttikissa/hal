import { test, expect } from 'bun:test'
import { oklch } from './oklch.ts'
import { termCaps } from './term-caps.ts'

test('black', () => {
	expect(oklch.oklchToRgb(0, 0, 0)).toEqual([0, 0, 0])
})


test('OKLCH black has zero lightness and zero chroma', () => {
	expect(oklch.isBlack(0, 0)).toBe(true)
	expect(oklch.isBlack(0, 0.01)).toBe(false)
	expect(oklch.isBlack(0.01, 0)).toBe(false)
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
	const esc = oklch.toAnsi(38, 0.5, 0, 0)
	expect(esc).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/)
})

test('toBg produces ANSI background escape', () => {
	const esc = oklch.toAnsi(48, 0.5, 0, 0)
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


test('usageFg moves from green toward red as usage rises', () => {
	const green = oklch.usageFg(0)
	const red = oklch.usageFg(100)
	expect(green).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/)
	expect(red).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/)
	expect(green).not.toBe(red)
})

test('fgHex extracts a cursor color from an OKLCH-derived foreground escape', () => {
	const color = oklch.toAnsi(38, 0.5, 0.1, 90)
	expect(oklch.fgHex(color)).toMatch(/^[0-9a-f]{6}$/)
})

test('mixFg interpolates foreground escapes', () => {
	const start = oklch.toAnsi(38, 0.4, 0, 0)
	const end = oklch.toAnsi(38, 0.8, 0, 0)
	expect(oklch.mixFg(start, end, 0.5)).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/)
	expect(oklch.mixFg(start, end, 0)).toBe(start)
	expect(oklch.mixFg(start, end, 1)).toBe(end)
})

test('maps foregrounds to the 16 base colors and drops backgrounds without truecolor', () => {
	termCaps.config.truecolor = false
	try {
		// Backgrounds vanish: screen has no back-color-erase to paint them with.
		expect(oklch.toAnsi(48, 0.3, 0.08, 25)).toBe('')
		// Hal's orange, an error's red and a user's blue stay distinguishable.
		expect(oklch.toAnsi(38, 0.75, 0.15, 55)).toBe('\x1b[93m')
		expect(oklch.toAnsi(38, 0.70, 0.20, 25)).toBe('\x1b[91m')
		expect(oklch.toAnsi(38, 0.70, 0.12, 245)).toBe('\x1b[94m')
		// Achromatic text is white, and dark text never becomes black-on-black.
		expect(oklch.toAnsi(38, 0.64, 0, 0)).toBe('\x1b[97m')
		expect(oklch.toAnsi(38, 0.25, 0, 0)).toBe('\x1b[37m')
	} finally {
		termCaps.config.truecolor = true
	}
})
