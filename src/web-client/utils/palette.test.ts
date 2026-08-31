import { expect, test } from 'bun:test'
import { palette } from './palette.ts'

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
	const css = palette.css(SOURCE)

	expect(css).toContain('.ToolCard {\n\t--tool-fg: oklch(0.8 0.15 250);\n\t--tool-bg: oklch(0.25 0.04 250);\n}')
	expect(css).toContain('.ToolCard-bash {\n\t--tool-fg: oklch(0.8 0.15 320);\n\t--tool-bg: oklch(0.25 0.04 320);\n}')
})

test('read-like tools share the read colors, as the terminal aliases them', () => {
	const css = palette.css(SOURCE)

	for (const alias of ['grep', 'glob', 'ls']) {
		expect(css).toContain(`.ToolCard-${alias} {\n\t--tool-fg: oklch(0.8 0.15 155);\n\t--tool-bg: oklch(0.25 0.04 155);\n}`)
	}
})

test('only tool colors are emitted, and unusable triples are skipped', () => {
	expect(palette.css(SOURCE)).not.toContain('assistant')
	expect(palette.css(`{ tools: { bash: { fg: [0.8, 0.15], bg: ["$missing", 0, 0] } } }`)).toBe('')
})

test('live reload applies colors.ason edits and stays quiet while it is unchanged', async () => {
	const sources = ['{ tools: { bash: { fg: [0.8, 0.15, 320], bg: [0.25, 0.04, 320] } } }', '', '']
	const applied: string[] = []
	let reads = 0
	const originalFetchSource = palette.fetchSource
	const originalPause = palette.pause
	try {
		palette.fetchSource = async () => sources[reads++] ?? ''
		palette.pause = async () => {}
		await palette.sync((css) => applied.push(css), () => reads >= sources.length)

		// Two distinct sources, three reads: the repeated one must not restyle.
		expect(applied).toEqual(['.ToolCard-bash {\n\t--tool-fg: oklch(0.8 0.15 320);\n\t--tool-bg: oklch(0.25 0.04 320);\n}', ''])
	} finally {
		palette.fetchSource = originalFetchSource
		palette.pause = originalPause
	}
})
