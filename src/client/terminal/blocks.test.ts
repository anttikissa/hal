import { expect, test } from 'bun:test'
import { blocks, type Block } from './blocks.ts'
import { blockData } from '../block-data.ts'
import { colors } from './colors.ts'
import { subscriptionUsage } from '../../common/subscription-usage.ts'
import { blockText } from './block-text.ts'
import { visLen } from '../../utils/strings.ts'

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

test('block body keeps left and right margins when wrapping', () => {
	expect(contentLines(blocks.renderBlock({ type: 'user', text: 'foo bar' }, 9))).toEqual([' foo bar'])
	expect(contentLines(blocks.renderBlock({ type: 'user', text: 'foo bar' }, 8))).toEqual([' foo', ' bar'])
})

test('block left padding can be disabled', () => {
	blocks.outputPad = 0
	try {
		const rendered = blocks.renderBlock({ type: 'user', text: '12345678' }, 9)
		expect(headerLine(rendered)).toStartWith('You')
		expect(contentLines(rendered)).toEqual(['12345678'])
	} finally { blocks.outputPad = 1 }
})

test('standalone plain URLs use one full-width logical line for terminal soft wrapping', () => {
	const url = 'https://example.com/abcdefghijklmnopqrstuvwxyz'
	const rendered = blocks.renderBlock({ type: 'info', text: `Open this URL:\n\n${url}` }, 20)
	const urlLines = rendered.filter((line) => line.includes('example.com'))

	expect(urlLines).toHaveLength(1)
	expect(urlLines[0]).toContain(url)
	expect(urlLines[0]).toContain(`;${url}\x07${url}\x1b]8;;\x07`)
	expect(blockText.stripAnsiSequences(urlLines[0]!)).toBe(url)
	const streaming = blocks.renderBlock({ type: 'assistant', text: url, streaming: true }, 20)
	expect(streaming.filter((line) => line.includes('example.com')).length).toBeGreaterThan(1)
})

test('block headers keep a right margin', () => {
	// Header text (title on the left, blob ref on the right) must stop one column
	// short of the terminal edge, matching the body margin.
	const longTitle = blocks.renderBlock({ type: 'tool', name: 'bash', input: { command: 'z'.repeat(200) } }, 40)
	expect(stripAnsi(longTitle[0]!)).toMatch(/ $/)
	expect(stripAnsi(longTitle[0]!).length).toBe(39)

	const withBlobRef = blocks.renderBlock({ type: 'error', text: 'boom', blobId: '0008sg-46t', sessionId: '102-era' }, 40)
	expect(stripAnsi(withBlobRef[0]!)).toMatch(/\) $/)
	expect(stripAnsi(withBlobRef[0]!).length).toBe(39)
})


test('streaming cursor leaves the terminal last column unused', () => {
	const lines = blocks.renderBlock({ type: 'thinking', text: '1234567', streaming: true }, 9, true)
	for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(8)
})


test('question controls honor wide-character widths', () => {
	const question: any = { type: 'question', id: 'q1', text: '選択してください', input: { kind: 'choice', choices: [{ id: 'no', label: 'No', description: '非常に長い説明です' }, { id: 'yes', label: 'Yes' }] }, source: { type: 'intro' }, active: true }
	const rendered = blocks.renderBlockDetailed(question, 20)
	for (const line of rendered.lines) expect(visLen(line)).toBeLessThanOrEqual(20)
})

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


test('tool output wraps long lines instead of clipping them', () => {
	const output = 'Waiting for the next subagent. Active: 118-mar (Wait display smoke test A, tab 15), 118-der (Wait display smoke test B, tab 14)'
	const content = contentLines(blocks.renderBlock({ type: 'tool', name: 'wait', output }, 42)).map((line) => line.trim())

	expect(content.length).toBeGreaterThan(1)
	expect(content.join(' ')).toBe(output)
	expect(content.join('\n')).not.toContain('…')
})


test('tool output truncation keeps four head lines and the tail by default', () => {
	const oldMax = blocks.config.maxToolOutputLines
	blocks.config.maxToolOutputLines = 2
	try {
		const output = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join('\n')
		const clean = blocks.renderBlock({ type: 'tool', name: 'bash', output }, 80).map(stripAnsi)
		expect(clean.some((line) => line.trim() === 'line 1')).toBe(true)
		expect(clean.some((line) => line.trim() === '[+ 2 lines]')).toBe(true)
		expect(clean.some((line) => line.trim() === 'line 5')).toBe(false)
		expect(clean.some((line) => line.trim() === 'line 7')).toBe(true)
	} finally {
		blocks.config.maxToolOutputLines = oldMax
	}
})


test('default tool output shows all lines when protected head and tail overlap', () => {
	const output = Array.from({ length: 17 }, (_, index) => `line ${index + 1}`).join('\n')
	const clean = blocks.renderBlock({ type: 'tool', name: 'bash', output }, 80).map(stripAnsi)
	expect(clean.some((line) => line.trim().startsWith('[+ '))).toBe(false)
	expect(clean.some((line) => line.trim() === 'line 1')).toBe(true)
	expect(clean.some((line) => line.trim() === 'line 17')).toBe(true)
})


test('search tool output truncation keeps head', () => {
	const oldMax = blocks.config.maxToolOutputLines
	blocks.config.maxToolOutputLines = 2
	try {
		for (const name of ['google', 'web_search']) {
			const clean = blocks.renderBlock({ type: 'tool', name, output: 'one\ntwo\nthree\nfour' }, 80).map(stripAnsi)
			expect(clean.some((line) => line.trim() === 'one')).toBe(true)
			expect(clean.some((line) => line.trim() === 'two')).toBe(true)
			expect(clean.some((line) => line.trim() === 'four')).toBe(false)
			expect(clean.findIndex((line) => line.trim() === '[+ 2 lines]')).toBeGreaterThan(clean.findIndex((line) => line.trim() === 'two'))
		}
	} finally {
		blocks.config.maxToolOutputLines = oldMax
	}
})

test('short status notices share one unlabelled transparent style without marker brackets', () => {
	colors.load()
	const block = { type: 'log', text: '[paused]', ts: new Date('2026-01-01T17:38:00Z').getTime() } as const
	const rendered = blocks.renderBlock(block, 80)
	const lines = rendered.map(stripAnsi)
	const info = blocks.renderBlock({ ...block, type: 'info' }, 80)

	expect(lines).toHaveLength(1)
	expect(lines[0]).toContain('Paused')
	expect(lines[0]).not.toContain('Log')
	expect(lines[0]).not.toContain('[paused]')
	expect(info).toEqual(rendered)
	expect(rendered.join('\n')).toContain(colors.log.fg)
	expect(rendered.join('\n')).not.toContain(colors.log.bg)
	expect(stripAnsi(rendered.join('\n'))).not.toContain('System')
})

test('multiword status notices also drop marker brackets', () => {
	const lines = blocks.renderBlock({ type: 'log', text: '[paused before local tools]' }, 80).map(stripAnsi)

	expect(lines[0]).toContain('Paused before local tools')
	expect(lines[0]).not.toContain('Log')
	expect(lines[0]).not.toContain('[paused before local tools]')
})

test('status markers lose brackets inside mixed log groups', () => {
	const lines = blocks.renderBlockGroup([
		{ type: 'log', text: '[restarted]' },
		{ type: 'log', text: 'Nothing to continue' },
	], 80).map(stripAnsi)

	expect(lines.join('\n')).toContain('Restarted')
	expect(lines.join('\n')).not.toContain('[restarted]')
})

test('usage bar markers gain terminal color only when marked trusted', () => {
	const bar = subscriptionUsage.usageBarMarker(50, 2)
	expect(bar).not.toContain('\x1b[')
	const trusted = blocks.renderBlock({ type: 'log', text: bar, usageBars: true }, 80).join('\n')
	const untrusted = blocks.renderBlock({ type: 'log', text: bar }, 80).join('\n')

	expect(trusted).toContain('\x1b[48;2;61;61;61m')
	expect(untrusted).not.toContain('\x1b[48;2;61;61;61m')
	const unsafe = blocks.renderBlock({ type: 'log', text: `${bar}\x1b[2J`, usageBars: true }, 80).join('\n')
	expect(unsafe).not.toContain('\x1b[2J')
})

test('long notices render without card padding', () => {
	const block: Block = { type: 'info', text: 'First line of a longer notice.\nSecond line.' }
	const lines = blocks.renderBlock(block, 80).map(stripAnsi)

	expect(lines.map((line) => line.trim())).toEqual(['First line of a longer notice.', 'Second line.'])
})

test('incoming prompts name their sender, tab, and optional tab name', () => {
	colors.load()
	const block: Block = {
		type: 'user',
		text: 'hello from another session',
		source: '09-bx8',
		sourceTab: 9,
		sourceName: 'Architecture revamp',
		ts: new Date('2026-01-01T17:37:00Z').getTime(),
	}

	const lines = blocks.renderBlock(block, 80)
	const header = headerLine(lines)
	const rendered = lines.join('\n')

	expect(header).toContain('Message from 09-bx8 (tab 9: Architecture revamp)')
	expect(rendered).toContain(colors.user.fg)
	expect(rendered).toContain(colors.user.bg)
	expect(rendered).not.toContain(colors.info.bg)
})

test('user blocks use user colors', () => {
	colors.load()
	const block: Block = { type: 'user', text: 'hello' }
	const rendered = blocks.renderBlock(block, 80).join('\n')

	expect(rendered).toContain(colors.user.fg)
	expect(rendered).toContain(colors.user.bg)
	expect(rendered).not.toContain(colors.info.bg)
})


test('queued prompts use the warning card regardless of source', () => {
	colors.load()
	const queued = [
		{ block: { type: 'log', text: 'Prompt queued\nfoobar' } as const, header: 'Prompt queued' },
		{ block: { type: 'log', text: 'Prompt queued from 09-bx8 (tab 9: Architecture revamp)\nfoobar' } as const, header: 'Prompt queued from 09-bx8 (tab 9: Architecture revamp)' }
	]
	for (const { block, header } of queued) {
		const lines = blocks.renderBlock(block, 80)
		const rendered = lines.join('\n')
		expect(headerLine(lines)).toContain(header)
		expect(contentLines(lines)).toContain(' foobar')
		expect(rendered).toContain(colors.warning.fg)
		expect(rendered).toContain(colors.warning.bg)
	}
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


test('canceled user and assistant headers show canceled marker', () => {
	const userHeader = headerLine(blocks.renderBlock({ type: 'user', text: 'old prompt', canceled: true }, 80))
	const assistantHeader = headerLine(blocks.renderBlock({ type: 'assistant', text: 'old answer', model: 'gpt-5.4', canceled: true }, 80))
	const thinkingHeader = headerLine(blocks.renderBlock({ type: 'thinking', text: 'old thought', model: 'gpt-5.4', thinkingEffort: 'high', canceled: true }, 80))

	expect(userHeader).toContain('You (canceled)')
	expect(assistantHeader).toContain('Hal (GPT 5.4, canceled)')
	expect(thinkingHeader).toContain('Hal (GPT 5.4, thinking high, canceled)')
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

test('synthetic assistant header omits the model', () => {
	const block: Block = {
		type: 'assistant',
		text: 'hello',
		model: 'gpt-5.4',
		synthetic: true,
	}

	const header = headerLine(blocks.renderBlock(block, 80))
	expect(header).toContain('Hal (synthetic)')
	expect(header).not.toContain('GPT 5.4')
})

test('what summary header uses the synthetic label', () => {
	const block: Block = {
		type: 'assistant',
		text: 'hello',
		model: 'gpt-5.4',
		synthetic: true,
		syntheticKind: 'what-summary',
	}

	const header = headerLine(blocks.renderBlock(block, 80))
	expect(header).toContain('Hal (synthetic)')
	expect(header).not.toContain('GPT 5.4')
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
		const palette = type === 'log' || type === 'info' ? colors.log : (colors as any)[type]
		const rendered = blocks.renderBlock(block, 80).join('\n')

		expect(palette.code).toBeTruthy()
		expect(rendered).toContain(`${palette.code}const x = 1${palette.fg}`)
		expect(rendered).not.toContain('\x1b[2mconst x = 1')
	}
})

test('streaming code-fence delimiters never create transient rows', () => {
	function rendered(text: string): string[] {
		return blocks.renderBlock({ type: 'assistant', text, streaming: true }, 40, true)
			.map(stripAnsi)
			.filter((line) => line.trim() !== '█')
			.map((line) => line.replace('█', ''))
	}

	const beforeFence = rendered('before')
	expect(rendered('before\n\n`')).toEqual(beforeFence)
	expect(rendered('before\n\n``')).toEqual(beforeFence)
	expect(rendered('before\n\n```')).toEqual(beforeFence)

	const insideFence = rendered('before\n\n```\nhost')
	expect(rendered('before\n\n```\nhost\n`')).toEqual(insideFence)
	expect(rendered('before\n\n```\nhost\n``')).toEqual(insideFence)
	expect(rendered('before\n\n```\nhost\n```')).toEqual(insideFence)
})

test('inline markdown code uses block code color instead of dim style', () => {
	colors.load()
	for (const type of markdownBlockTypes) {
		const block = { type, text: 'run `bun test` now' } as Block
		const palette = type === 'log' || type === 'info' ? colors.log : (colors as any)[type]
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

test('rendered block lines without tabs do not embed carriage returns', () => {
	const block: Block = {
		type: 'thinking',
		text: 'copy this header safely',
	}

	const lines = blocks.renderBlock(block, 80)
	expect(lines.some((line) => line.includes('\r'))).toBe(false)
})

test('rendered hashline tabs preserve source indentation', () => {
	const block: Block = {
		type: 'tool',
		name: 'edit',
		output: '--- before\n360:IS6 \tshort\n361:ZUg \t\tnested\n\n+++ after\n360:def \tshort\n361:ghi \t\tnested',
	}

	const rendered = blocks.renderBlock(block, 80).map(stripAnsi).join('\n')
	expect(rendered).toContain('− 360:IS6     short')
	expect(rendered).toContain('− 361:ZUg         nested')
	expect(rendered).not.toContain('\t')
})

test('block header uses plain layout without horizontal rules', () => {
	const block: Block = {
		type: 'thinking',
		text: 'x',
		blobId: 'q05d47-tzf',
		sessionId: '03-idr',
		ts: new Date('2026-04-14T05:32:00Z').getTime(),
	}

	const header = headerLine(blocks.renderBlock(block, 80))
	// One column short of the terminal width: the last column is the right margin.
	expect(header.length).toBe(79)
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

test('info history entries render without a category label', () => {
	const history: any[] = [{ type: 'info', text: 'Model set to GPT 5.5.', ts: '2026-04-09T20:00:00.000Z' }]

	const result = blockData.historyToBlocks(history as any, 'child')
	expect(result).toMatchObject([{ type: 'info', text: 'Model set to GPT 5.5.' }])
	const lines = blocks.renderBlock(result[0]!, 80)
	expect(headerLine(lines)).not.toContain('System')
})

test('structural cwd and model entries render as system blocks', () => {
	const history: any[] = [
		{ type: 'cwd', from: '/tmp', to: '/home/user/.hal/src', ts: '2026-04-09T20:00:00.000Z' },
		{ type: 'model', from: 'openai/gpt-5.5', to: 'anthropic/claude-opus-4-7', ts: '2026-04-09T20:01:00.000Z' },
	]

	const result = blockData.historyToBlocks(history as any, 'child')
	expect(result).toMatchObject([
		{ type: 'info', text: 'cwd: /tmp -> /home/user/.hal/src' },
		{ type: 'info', text: 'model: openai/gpt-5.5 -> anthropic/claude-opus-4-7' },
	])
})

test('short info blocks render as unlabelled timeline entries', () => {
	const block: Block = {
		type: 'info',
		text: 'Server started (pid 123) · ready 99.9ms',
		ts: new Date('2026-01-01T17:39:00Z').getTime(),
	}

	const lines = blocks.renderBlock(block, 80)
	expect(headerLine(lines)).not.toContain('System')
	expect(headerLine(lines)).toContain('Server started')
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
	expect(lines[1]).toBe(' 1 Jan 17:38 Bash: ./test                                 (11-ok3/000123-bash) ')
	expect(lines[1]).not.toContain('─')
	expect(lines[2]).toBe(' ')
	expect(lines[3]).toBe(' done')
	expect(lines[4]).toBe(' ')
	expect(lines.join('\n')).not.toContain('\n ./test\n')
})

