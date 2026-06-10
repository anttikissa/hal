import { expect, test } from 'bun:test'
import { blocks, type Block } from './blocks.ts'
import { blockData } from './block-data.ts'
import { colors } from './colors.ts'
import { visLen } from '../utils/strings.ts'

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
}

function headerLine(lines: string[]): string {
	return lines.map(stripAnsi).find((line) => line.trim()) ?? ''
}

function contentLines(lines: string[]): string[] {
	const clean = lines.map(stripAnsi)
	let start = clean.findIndex((line) => line.trim()) + 1
	const end = clean.at(-1)?.trim() ? clean.length : clean.length - 1
	if (!clean[start]?.trim()) start++
	return clean.slice(start, end)
}

function blockBodyStart(lines: string[]): number {
	const clean = lines.map(stripAnsi)
	const header = clean.findIndex((line) => line.trim())
	return header + 1
}

test('body blocks render a blank line after the header', () => {
	const samples: Block[] = [
		{ type: 'user', text: 'hello' },
		{ type: 'assistant', text: 'hello' },
		{ type: 'thinking', text: 'hello' },
		{ type: 'tool', name: 'bash', input: { command: 'echo hello' }, output: 'hello' },
	]

	for (const block of samples) {
		const lines = blocks.renderBlock(block, 80).map(stripAnsi)
		expect(lines[blockBodyStart(lines)]?.trim()).toBe('')
	}
})

test('bodyless tool blocks do not add a separator row', () => {
	const lines = blocks.renderBlock({ type: 'tool', name: 'bash', input: { command: 'true' } }, 80).map(stripAnsi)
	expect(lines.filter((line) => line.trim())).toHaveLength(1)
})

test('short status notices render on one line', () => {
	const lines = blocks.renderBlock({ type: 'log', text: '[paused]', ts: new Date('2026-01-01T17:38:00Z').getTime() }, 80).map(stripAnsi)

	expect(lines).toHaveLength(1)
	expect(lines[0]).toContain('Log: [paused]')
})

test('long notices render a blank line after the header', () => {
	const block: Block = { type: 'info', text: 'First line of a longer notice.\nSecond line.' }
	const lines = blocks.renderBlock(block, 80).map(stripAnsi)

	expect(lines[blockBodyStart(lines)]?.trim()).toBe('')
})

test('incoming user block shows inbox source instead of You', () => {
	const block: Block = {
		type: 'user',
		text: 'hello from another session',
		source: '09-bx8',
		ts: new Date('2026-01-01T17:37:00Z').getTime(),
	}

	const lines = blocks.renderBlock(block, 80)
	const header = headerLine(lines)

	expect(header).toContain('Inbox · 09-bx8')
	expect(header).not.toContain('You')
})

test('user blocks use user colors', () => {
	colors.load()
	const block: Block = { type: 'user', text: 'hello' }
	const rendered = blocks.renderBlock(block, 80).join('\n')

	expect(rendered).toContain(colors.user.fg)
	expect(rendered).toContain(colors.user.bg)
	expect(rendered).not.toContain(colors.info.bg)
})

test('thinking block renders markdown and trims trailing blank lines', () => {
	const block: Block = {
		type: 'thinking',
		text: '**Planning the fix**\n\nSome thoughts here.\n\n\n',
	}

	const lines = blocks.renderBlock(block, 80)
	const clean = lines.map((l) => stripAnsi(l))

	// Header is first line
	expect(clean[0]).toContain('Thinking')

	// **bold** should be rendered (not literal asterisks)
	const bodyText = clean.slice(1).join('\n')
	expect(bodyText).not.toContain('**')
	expect(bodyText).toContain('Planning the fix')

	// No trailing blank lines in content (last line should have actual text
	// or be the single blank line between "Planning" and "Some thoughts")
	const lastContentLine = clean[clean.length - 1]!
	expect(lastContentLine.trim()).not.toBe('')
})

test('assistant header includes display model', () => {
	const block: Block = {
		type: 'assistant',
		text: 'hello',
		model: 'gpt-5.4',
	}

	const header = headerLine(blocks.renderBlock(block, 80))
	expect(header).toContain('Hal (GPT 5.4)')
})

test('assistant and thinking backgrounds come from colors', () => {
	colors.load()
	const assistantBlock: Block = { type: 'assistant', text: 'hello', model: 'gpt-5.4' }
	const thinkingBlock: Block = { type: 'thinking', text: 'hmm', model: 'gpt-5.4' }
	const assistantRendered = blocks.renderBlock(assistantBlock, 80).join('\n')
	const thinkingRendered = blocks.renderBlock(thinkingBlock, 80).join('\n')

	expect(colors.assistant.bg).toBeTruthy()
	expect(colors.thinking.bg).toBeTruthy()
	expect(assistantRendered).toContain(colors.assistant.bg)
	expect(thinkingRendered).toContain(colors.thinking.bg)
	expect(blocks.renderBlock(assistantBlock, 80).map(stripAnsi)[0]?.trim()).not.toBe('')
})

test('assistant block padding uses resolved OKLCH blackness', () => {
	const originalBg = colors.assistant.bg
	const originalBgIsBlack = colors.assistant.bgIsBlack
	try {
		const block: Block = { type: 'assistant', text: 'hello' }
		colors.assistant.bg = '\x1b[48;2;1;0;0m'
		colors.assistant.bgIsBlack = true
		expect(blocks.renderBlock(block, 80).map(stripAnsi)[0]?.trim()).not.toBe('')

		colors.assistant.bg = '\x1b[48;2;0;0;0m'
		colors.assistant.bgIsBlack = false
		const lines = blocks.renderBlock(block, 80).map(stripAnsi)
		expect(lines[0]).toBe(' ')
		expect(lines.at(-1)).toBe(' ')
	} finally {
		colors.assistant.bg = originalBg
		colors.assistant.bgIsBlack = originalBgIsBlack
	}
})

test('synthetic assistant header includes model and synthetic marker', () => {
	const block: Block = {
		type: 'assistant',
		text: 'hello',
		model: 'gpt-5.4',
		synthetic: true,
	}

	const header = headerLine(blocks.renderBlock(block, 80))
	expect(header).toContain('Hal (GPT 5.4, synthetic)')
})

test('thinking header includes model and default thinking level', () => {
	const block: Block = {
		type: 'thinking',
		text: 'hmm',
		model: 'gpt-5.4',
	}

	const header = headerLine(blocks.renderBlock(block, 80))
	expect(header).toContain('Hal (GPT 5.4, thinking high)')
})

test('info block renders markdown tables', () => {
	const block: Block = {
		type: 'info',
		text: 'OpenAI subscriptions:\n\n| Active | Slot | Account |\n|---|---|---|\n| * | 1/2 | a@test.com |',
	}

	const lines = blocks.renderBlock(block, 80).map((l) => stripAnsi(l))
	const body = lines.slice(1)

	expect(body).toContain(' ┌────────┬──────┬────────────┐')
	expect(body).toContain(' │ Active │ Slot │ Account    │')
	expect(body).toContain(' │ *      │ 1/2  │ a@test.com │')
})

const markdownBlockTypes = ['assistant', 'thinking', 'log', 'info', 'warning', 'error'] as const

test('markdown code fences use block code color instead of dim style', () => {
	colors.load()
	for (const type of markdownBlockTypes) {
		const block = { type, text: 'before\n```ts\nconst x = 1\n```\nafter' } as Block
		const palette = (colors as any)[type]
		const rendered = blocks.renderBlock(block, 80).join('\n')

		expect(palette.code).toBeTruthy()
		expect(rendered).toContain(`${palette.code}const x = 1${palette.fg}`)
		expect(rendered).not.toContain('\x1b[2mconst x = 1')
	}
})

test('inline markdown code uses block code color instead of dim style', () => {
	colors.load()
	for (const type of markdownBlockTypes) {
		const block = { type, text: 'run `bun test` now' } as Block
		const palette = (colors as any)[type]
		const rendered = blocks.renderBlock(block, 80).join('\n')

		expect(palette.code).toBeTruthy()
		expect(rendered).toContain(`${palette.code}bun test${palette.fg}`)
		expect(rendered).not.toContain('\x1b[2mbun test')
	}
})

test('text code fences wrap at word boundaries', () => {
	const block = { type: 'assistant', text: '```text\nOpen without an initial prompt.\n```' } as Block
	const lines = contentLines(blocks.renderBlock(block, 21))

	expect(lines).toEqual([
		' Open without an',
		' initial prompt.',
	])
})

test('wrapped URLs use OSC 8 links for every visual segment', () => {
	const url = `https://claude.ai/oauth/authorize?client_id=${'a'.repeat(80)}`
	const lines = blocks.renderBlock({ type: 'log', text: url }, 40)
	const rendered = lines.join('\n')
	const openLink = `\x1b]8;;${url}\x07`

	expect(rendered).toContain(`${openLink}https://`)
	expect(rendered.split(openLink).length - 1).toBeGreaterThan(1)
	for (const line of lines) expect(visLen(line)).toBeLessThanOrEqual(40)
})

test('rendered block lines without tabs do not embed carriage returns', () => {
	const block: Block = {
		type: 'thinking',
		text: 'copy this header safely',
	}

	const lines = blocks.renderBlock(block, 80)
	expect(lines.some((line) => line.includes('\r'))).toBe(false)
})

test('block header uses plain full-width layout without horizontal rules', () => {
	const block: Block = {
		type: 'thinking',
		text: 'x',
		blobId: 'q05d47-tzf',
		sessionId: '03-idr',
		ts: new Date('2026-04-14T05:32:00Z').getTime(),
	}

	const header = headerLine(blocks.renderBlock(block, 80))
	expect(header.length).toBe(80)
	expect(header).not.toContain('─')
	expect(header).toContain('03-idr/q05d47-tzf')
})

test('forked_from history entry renders as a Fork block', () => {
	const history: any[] = [{ type: 'forked_from', parent: '04-abc', ts: '2026-04-09T20:00:00.000Z' }]

	const result = blockData.historyToBlocks(history as any, 'child')
	expect(result).toMatchObject([{ type: 'fork', text: 'Tab forked from 04-abc.' }])
	const lines = blocks.renderBlock(result[0]!, 80)
	expect(headerLine(lines)).toContain('Fork')
})

test('forked_to history entry renders as a Fork block', () => {
	const history: any[] = [{ type: 'forked_to', child: '04-def', ts: '2026-04-09T20:00:00.000Z' }]

	const result = blockData.historyToBlocks(history as any, 'parent')
	expect(result).toMatchObject([{ type: 'fork', text: 'Tab forked to 04-def.' }])
	const lines = blocks.renderBlock(result[0]!, 80)
	expect(headerLine(lines)).toContain('Fork')
})

test('info history entries render as system blocks', () => {
	const history: any[] = [{ type: 'info', text: 'Model set to GPT 5.5.', ts: '2026-04-09T20:00:00.000Z' }]

	const result = blockData.historyToBlocks(history as any, 'child')
	expect(result).toMatchObject([{ type: 'info', text: 'Model set to GPT 5.5.' }])
	const lines = blocks.renderBlock(result[0]!, 80)
	expect(headerLine(lines)).toContain('System')
})

test('structural cwd and model entries render as system blocks', () => {
	const history: any[] = [
		{ type: 'cwd', from: '/tmp', to: '/Users/antti/.hal/src', ts: '2026-04-09T20:00:00.000Z' },
		{ type: 'model', from: 'openai/gpt-5.5', to: 'anthropic/claude-opus-4-7', ts: '2026-04-09T20:01:00.000Z' },
	]

	const result = blockData.historyToBlocks(history as any, 'child')
	expect(result).toMatchObject([
		{ type: 'info', text: 'cwd: /tmp -> /Users/antti/.hal/src' },
		{ type: 'info', text: 'model: openai/gpt-5.5 -> anthropic/claude-opus-4-7' },
	])
})

test('info block renders a System header', () => {
	const block: Block = {
		type: 'info',
		text: 'Server started (pid 123) · ready 99.9ms',
		ts: new Date('2026-01-01T17:39:00Z').getTime(),
	}

	const lines = blocks.renderBlock(block, 80)
	expect(headerLine(lines)).toContain('System')
	expect(stripAnsi(lines.slice(1).join('\n'))).toContain('Server started')
})

test('warning block renders a Warning header', () => {
	const block: Block = {
		type: 'warning',
		text: 'Memory high: 1.60 GB RSS',
		ts: new Date('2026-01-01T17:38:00Z').getTime(),
	}

	const lines = blocks.renderBlock(block, 80)
	const header = headerLine(lines)

	expect(header).toContain('Warning')
	expect(header).not.toContain('Info')
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

test('error block header shows blob ref', () => {
	const block = {
		type: 'error',
		text: 'Short error message',
		sessionId: '04-abc',
		blobId: '000003-err',
		ts: new Date('2026-01-01T17:38:00Z').getTime(),
	} as Block

	const header = headerLine(blocks.renderBlock(block, 100))
	expect(header).toContain('04-abc/000003-err')
})

test('tool block header uses padded text without horizontal rules', () => {
	const block: Block = {
		type: 'tool',
		name: 'bash',
		input: { command: './test' },
		output: 'done',
		sessionId: '11-ok3',
		blobId: '000123-bash',
		ts: new Date('2026-01-01T17:38:00Z').getTime(),
	}

	const rendered = blocks.renderBlock(block, 80)
	const lines = rendered.map((l) => stripAnsi(l))

	expect(rendered[0]?.startsWith(colors.tool('bash').bg)).toBe(true)
	expect(lines[0]).toBe(' ')
	expect(lines[1]).toBe(' 1 Jan 17:38 Bash: ./test                                  (11-ok3/000123-bash) ')
	expect(lines[1]).not.toContain('─')
	expect(lines[2]).toBe(' ')
	expect(lines[3]).toBe(' done')
	expect(lines[4]).toBe(' ')
	expect(lines.join('\n')).not.toContain('\n ./test\n')
})

