import { test, expect } from 'bun:test'
import { oklch } from './oklch.ts'
import { termCaps } from './term-caps.ts'

test('toFg produces ANSI foreground escape', () => {
	const esc = oklch.toAnsi(38, 0.5, 0, 0)
	expect(esc).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/)
})

test('toBg produces ANSI background escape', () => {
	const esc = oklch.toAnsi(48, 0.5, 0, 0)
	expect(esc).toMatch(/^\x1b\[48;2;\d+;\d+;\d+m$/)
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
