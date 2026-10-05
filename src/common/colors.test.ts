import { expect, test } from 'bun:test'
import { readdirSync } from 'fs'
import { colors, DERIVED, type Style } from './colors.ts'
import { oklch, type Oklch } from './oklch.ts'

// Shared values (fgL, screen) are a number or one color; the rest are styles.
const styles = () => Object.entries(colors).filter(([key, value]) => typeof value === 'function' && !(DERIVED as readonly string[]).includes(key)).map(([key, value]) => [key, (value as () => Style)()] as const)

test('every style is a set of OKLCH colors', () => {
	for (let [key, style] of styles()) {
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

// tasks/README.md, readable text: WCAG AA against the background each
// color sits on, its style's own bg or else the screen we design for.
function readable(): string[] {
	// placeholder: the example request, faint on purpose (frame.test.ts
	// checks it stands apart from both the box and typed text).
	let backgrounds = /^(bg|canvas|field|border|button|placeholder)$|Bg$/
	let marks = /^(cursor|cursorIdle)$/
	let low: string[] = []
	let check = (name: string, fg: Oklch, bg: Oklch, min: number) => {
		let r = oklch.contrast(fg, bg)
		if (r < min) low.push(`${name} ${r.toFixed(2)}`)
	}
	for (let [key, style] of styles()) {
		let bg = style.bg ?? colors.screen
		for (let [part, c] of Object.entries(style)) {
			if (backgrounds.test(part)) continue
			check(`${key}.${part}`, c, bg, marks.test(part) ? 3 : 4.5)
			if (marks.test(part)) continue
			check(`${key}.${part} quieter`, oklch.quiet(c, bg), bg, 4.5)
			if (style.linkBg) check(`${key}.${part} on linkBg`, c, style.linkBg, 4.5)
		}
	}
	let page = colors.page()
	for (let on of ['field', 'button'] as const) check(`page.text on ${on}`, page.text!, page[on]!, 4.5)
	check('page.border', page.border!, page.canvas!, 3)
	return low
}

test('every color is readable where it is drawn, and so is its quieter form', () => {
	expect(readable()).toEqual([])
})

// Each theme (task d3) keeps the same rule, applied as its plugin would.
test('every shipped theme is readable too', async () => {
	let dir = `${import.meta.dir}/../../themes`
	let names = readdirSync(dir).filter((f) => f.endsWith('.ts'))
	expect(names.length).toBeGreaterThan(0)
	for (let name of names) {
		let { look } = await import(`${dir}/${name}`)
		let saved = { ...colors }
		try {
			for (let [key, v] of Object.entries(look as Record<string, unknown>)) {
				let base = saved[key as keyof typeof colors]
				;(colors as Record<string, unknown>)[key] = typeof v === 'function' ? () => v(base) : v
			}
			expect(readable(), name).toEqual([])
		} finally {
			Object.assign(colors, saved)
		}
	}
})
