import { expect, test } from 'bun:test'
import { palette } from './palette.ts'
import { colorCss } from '../../common/color-css.ts'

const SOURCE = `{
	vars: { fgL: 0.80, fgC: 0.15, bgL: 0.25, bgC: 0.04 },
	assistant: { fg: [0.8, 0.15, 55] },
	tools: {
		default: { fg: ["$fgL", "$fgC", 250], bg: ["$bgL", "$bgC", 250] },
		bash: { fg: ["$fgL", "$fgC", 320], bg: ["$bgL", "$bgC", 320] },
		read: { fg: [0.8, 0.15, 155], bg: [0.25, 0.04, 155] },
	},
}`

test('tool colors become CSS custom properties straight from the oklch triples', () => {
	const css = colorCss.css(SOURCE)

	expect(css).toContain('.ToolCard {\n\t--tool-fg: oklch(0.8 0.15 250);\n\t--tool-bg: oklch(0.25 0.04 250);\n}')
	expect(css).toContain('.ToolCard-bash {\n\t--tool-fg: oklch(0.8 0.15 320);\n\t--tool-bg: oklch(0.25 0.04 320);\n}')
})

test('read-like tools share the read colors, as the terminal aliases them', () => {
	const css = colorCss.css(SOURCE)

	for (const alias of ['grep', 'glob', 'ls']) {
		expect(css).toContain(`.ToolCard-${alias} {\n\t--tool-fg: oklch(0.8 0.15 155);\n\t--tool-bg: oklch(0.25 0.04 155);\n}`)
	}
})

test('all transcript and composer roles resolve to CSS variables', () => {
	const css = colorCss.css(`{ vars: { shade: 0.8 }, assistant: { fg: ["$shade", 0.15, 55], bg: [0, 0, 55], cursor: [0.9, 0.1, 55] }, user: { fg: [0.82, 0.11, 220], bg: [0.29, 0.05, 220] }, input: { bg: [0.29, 0.05, 220], cursor: [0.82, 0.11, 220] }, thinking: { fg: [0.72, 0.03, 250] }, help: { key: [0.76, 0, 250] }, status: { fg: [0.64, 0, 0] } }`)
	expect(css).toContain('--assistant-fg: oklch(0.8 0.15 55);')
	expect(css).toContain('--assistant-cursor: oklch(0.9 0.1 55);')
	expect(css).toContain('--user-bg: oklch(0.29 0.05 220);')
	expect(css).toContain('--input-bg: oklch(0.29 0.05 220);')
	expect(css).toContain('--thinking-fg: oklch(0.72 0.03 250);')
	expect(css).toContain('--help-key: oklch(0.76 0 250);')
	expect(css).toContain('--status-fg: oklch(0.64 0 0);')
})

test('invalid triples and selectors never enter the CSS', () => {
	expect(colorCss.css(`{ tools: { "x} body { color: red": { fg: [0.8, 0.15, 320], bg: [0.25, 0.04, 320] }, bash: { fg: [0.8, 0.15], bg: ["$missing", 0, 0] } } }`)).toBe('')
})

test('live reload applies CSS edits and stays quiet while it is unchanged', async () => {
	const sources = ['.ToolCard-bash { --tool-fg: oklch(0.8 0.15 320); }', '', '']
	const applied: string[] = []
	let reads = 0
	const originalFetchSource = palette.fetchSource
	const originalPause = palette.pause
	try {
		palette.fetchSource = async () => sources[reads++] ?? ''
		palette.pause = async () => {}
		await palette.sync((css) => applied.push(css), () => reads >= sources.length)

		// Two distinct sources, three reads: the repeated one must not restyle.
		expect(applied).toEqual([sources[0]!, ''])
	} finally {
		palette.fetchSource = originalFetchSource
		palette.pause = originalPause
	}
})
