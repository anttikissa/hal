import { expect, test } from 'bun:test'
import { blocks, type Block } from './blocks.ts'
import { colors } from './colors.ts'
import { visLen } from '../../utils/strings.ts'
import { blockText } from './block-text.ts'

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
}

test('wrapped URLs use one OSC 8 link identity for every visual segment', () => {
	const url = `https://claude.ai/oauth/authorize?client_id=${'a'.repeat(80)}`
	const lines = blocks.renderBlock({ type: 'log', text: url }, 40)
	const rendered = lines.join('\n')
	const links = Array.from(rendered.matchAll(/\x1b\]8;id=([^;]+);(.*?)\x07/g), (match) => ({ id: match[1]!, target: match[2]! }))

	expect(links.length).toBeGreaterThan(1)
	for (const link of links) {
		expect(link.id).toBe(links[0]!.id)
		expect(link.target).toBe(url)
	}
	for (const line of lines) expect(visLen(line)).toBeLessThanOrEqual(40)
})

test('styled wrapped URLs keep ANSI sequences out of OSC 8 targets', () => {
	colors.load()
	const url = `https://example.com/inspect/long-url?token=${'a'.repeat(157)}`
	expect(url).toHaveLength(200)
	const text = `\`\`\`text\n${url}\n\`\`\``
	const rendered = blocks.renderBlock({ type: 'assistant', text }, 40).join('\n')
	const targets = Array.from(rendered.matchAll(/\x1b\]8;(?:id=[^;]+)?;(.*?)\x07/g), (match) => match[1]!).filter(Boolean)

	expect(targets.length).toBeGreaterThan(1)
	for (const target of targets) expect(target).toBe(url)
})

test('wrapped Markdown links keep their target hidden and clickable on every line', () => {
	colors.load()
	const linkBg = colors.assistant.linkBg
	if (!linkBg) throw new Error('missing assistant link background')
	const url = 'https://example.com/reference'
	const label = 'read this detailed reference before continuing'
	const lines = blocks.renderBlock({ type: 'assistant', text: `[${label}](${url})` }, 24)
	const rendered = lines.join('\n')
	const targets = Array.from(rendered.matchAll(/\x1b\]8;;(.*?)\x07/g), (match) => match[1]!).filter(Boolean)
	const plain = blockText.stripAnsiSequences(rendered)

	expect(targets.length).toBeGreaterThan(1)
	for (const target of targets) expect(target).toBe(url)
	for (const line of lines.filter((line) => line.includes(`\x1b]8;;${url}\x07`))) {
		expect(line).toContain(linkBg)
		expect(line).not.toContain('\x1b[4m')
		expect(line).toContain(colors.assistant.code)
	}
	expect(plain.replace(/\s+/g, ' ')).toContain(label)
	expect(plain).not.toContain(url)
	expect(plain).not.toContain(`[${label}]`)
	for (const line of lines) expect(visLen(line)).toBeLessThanOrEqual(24)
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
