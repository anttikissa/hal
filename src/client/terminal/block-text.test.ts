import { expect, test } from 'bun:test'
import { blocks, type Block } from './blocks.ts'
import { colors } from './colors.ts'
import { visLen } from '../../utils/strings.ts'

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
}

test('wrapped URLs use OSC 8 links for every visual segment', () => {
	const url = `https://claude.ai/oauth/authorize?client_id=${'a'.repeat(80)}`
	const lines = blocks.renderBlock({ type: 'log', text: url }, 40)
	const rendered = lines.join('\n')
	const openLink = `\x1b]8;;${url}\x07`

	expect(rendered).toContain(`${openLink}https://`)
	expect(rendered.split(openLink).length - 1).toBeGreaterThan(1)
	for (const line of lines) expect(visLen(line)).toBeLessThanOrEqual(40)
})

test('styled wrapped URLs keep ANSI sequences out of OSC 8 targets', () => {
	colors.load()
	const url = `https://example.com/inspect/long-url?token=${'a'.repeat(157)}`
	expect(url).toHaveLength(200)
	const text = `\`\`\`text\n${url}\n\`\`\``
	const rendered = blocks.renderBlock({ type: 'assistant', text }, 40).join('\n')
	const targets = Array.from(rendered.matchAll(/\x1b\]8;;(.*?)\x07/g), (match) => match[1]!).filter(Boolean)

	expect(targets.length).toBeGreaterThan(1)
	for (const target of targets) expect(target).toBe(url)
})

test('tool output strips ANSI escapes but keeps other control bytes visible', () => {
	const block: Block = {
		type: 'tool',
		name: 'read',
		output: 'ok\r\n\x1b[2K\x1bHboom\n\x1b[38;2;245;145;69mline 11\x1b[49m\x1b[39m',
	}

	const lines = blocks.renderBlock(block, 80)
	const joined = lines.join('\n')
	const clean = lines.map((l) => stripAnsi(l)).join('\n')

	expect(joined).not.toContain('\x1b[2K')
	expect(joined).not.toContain('\x1bH')
	expect(joined).not.toContain('\x1b[38;2;245;145;69m')
	expect(joined).not.toContain('\rboom')
	expect(clean).toContain('␍')
	expect(clean).toContain('boom')
	expect(clean).toContain('line 11')
	expect(clean).not.toContain('␛')
})
