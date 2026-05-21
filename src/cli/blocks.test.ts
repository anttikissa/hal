import { expect, test } from 'bun:test'
import { blocks, type Block } from './blocks.ts'
import { colors } from './colors.ts'

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
}

test('incoming user block shows inbox source instead of You', () => {
	const block: Block = {
		type: 'user',
		text: 'hello from another session',
		source: '09-bx8',
		ts: new Date('2026-01-01T17:37:00Z').getTime(),
	}

	const lines = blocks.renderBlock(block, 80)
	const header = stripAnsi(lines[0] ?? '')

	expect(header).toContain('Inbox · 09-bx8')
	expect(header).not.toContain('You')
})

test('historyToBlocks preserves original image path in user text', () => {
	const history: any[] = [
		{
			type: 'user',
			parts: [
				{ type: 'text', text: 'see ' },
				{ type: 'image', blobId: 'blob1', originalFile: '/tmp/hal/images/test.png' },
				{ type: 'text', text: ' now' },
			],
		},
	]

	const result = blocks.historyToBlocks(history as any, 's1')
	expect(result[0]).toMatchObject({ type: 'user', text: 'see [/tmp/hal/images/test.png] now' })
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

	const header = stripAnsi(blocks.renderBlock(block, 80)[0] ?? '')
	expect(header).toContain('Hal (GPT 5.4)')
})


test('synthetic assistant header includes model and synthetic marker', () => {
	const block: Block = {
		type: 'assistant',
		text: 'hello',
		model: 'gpt-5.4',
		synthetic: true,
	}

	const header = stripAnsi(blocks.renderBlock(block, 80)[0] ?? '')
	expect(header).toContain('Hal (GPT 5.4, synthetic)')
})

test('thinking header includes model and default thinking level', () => {
	const block: Block = {
		type: 'thinking',
		text: 'hmm',
		model: 'gpt-5.4',
	}

	const header = stripAnsi(blocks.renderBlock(block, 80)[0] ?? '')
	expect(header).toContain('Hal (GPT 5.4, thinking high)')
})

test('historyToBlocks uses the session model for later assistant and thinking blocks', () => {
	const history: any[] = [
		{ type: 'thinking', text: 'hmm', ts: '2026-04-15T14:54:01.000Z' },
		{ type: 'assistant', text: 'done', ts: '2026-04-15T14:54:02.000Z' },
	]

	const rendered = blocks.historyToBlocks(history as any, 's1', 0, undefined, 'openai/gpt-5.4')
	expect(rendered[0]).toMatchObject({ type: 'thinking', model: 'openai/gpt-5.4', thinkingEffort: 'high' })
	expect(rendered[1]).toMatchObject({ type: 'assistant', model: 'openai/gpt-5.4' })
})

test('info block renders markdown tables', () => {
	const block: Block = {
		type: 'info',
		text: 'OpenAI subscriptions:\n\n| Active | Slot | Account |\n|---|---|---|\n| * | 1/2 | a@test.com |',
	}

	const lines = blocks.renderBlock(block, 80).map((l) => stripAnsi(l))
	const body = lines.slice(1)

	expect(body).toContain('┌────────┬──────┬────────────┐')
	expect(body).toContain('│ Active │ Slot │ Account    │')
	expect(body).toContain('│ *      │ 1/2  │ a@test.com │')
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

test('rendered block lines without tabs do not embed carriage returns', () => {
	const block: Block = {
		type: 'thinking',
		text: 'copy this header safely',
	}

	const lines = blocks.renderBlock(block, 80)
	expect(lines.some((line) => line.includes('\r'))).toBe(false)
})

test('block header leaves one column slack to avoid last-column wrap state', () => {
	const block: Block = {
		type: 'thinking',
		text: 'x',
		blobId: 'q05d47-tzf',
		sessionId: '03-idr',
		ts: new Date('2026-04-14T05:32:00Z').getTime(),
	}

	const header = stripAnsi(blocks.renderBlock(block, 80)[0] ?? '')
	expect(header.length).toBeLessThan(80)
})

test('forked_from history entry renders as an Info block', () => {
	const history: any[] = [{ type: 'forked_from', parent: '04-abc', ts: '2026-04-09T20:00:00.000Z' }]

	const result = blocks.historyToBlocks(history as any, 'child')
	expect(result).toMatchObject([{ type: 'info', text: 'Tab forked from 04-abc.' }])
	const lines = blocks.renderBlock(result[0]!, 80)
	expect(stripAnsi(lines[0] ?? '')).toContain('Info')
})

test('info history entries render as highlighted Info blocks', () => {
	const history: any[] = [{ type: 'info', text: 'Model set to GPT 5.5.', ts: '2026-04-09T20:00:00.000Z' }]

	const result = blocks.historyToBlocks(history as any, 'child')
	expect(result).toMatchObject([{ type: 'info', text: 'Model set to GPT 5.5.' }])
	const lines = blocks.renderBlock(result[0]!, 80)
	expect(stripAnsi(lines[0] ?? '')).toContain('Info')
})

test('info block renders an Info header', () => {
	const block: Block = {
		type: 'info',
		text: 'Server started (pid 123) · ready 99.9ms',
		ts: new Date('2026-01-01T17:39:00Z').getTime(),
	}

	const lines = blocks.renderBlock(block, 80)
	expect(stripAnsi(lines[0] ?? '')).toContain('Info')
	expect(stripAnsi(lines.slice(1).join('\n'))).toContain('Server started')
})

test('warning block renders a Warning header', () => {
	const block: Block = {
		type: 'warning',
		text: 'Memory high: 1.60 GB RSS',
		ts: new Date('2026-01-01T17:38:00Z').getTime(),
	}

	const lines = blocks.renderBlock(block, 80)
	const header = stripAnsi(lines[0] ?? '')

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

	const header = stripAnsi(blocks.renderBlock(block, 100)[0] ?? '')
	expect(header).toContain('04-abc/000003-err')
})

test('spawn_agent block renders full input args', () => {
	const block: Block = {
		type: 'tool',
		name: 'spawn_agent',
		toolId: 'call_123',
		input: {
			task: 'Design the benchmark prompt\nKeep it concise.',
			mode: 'fresh',
			model: 'openai/gpt-5.4',
			cwd: '/Users/antti/.hal',
			title: 'edit benchmark prompt',
			closeWhenDone: false,
		},
		output: 'Queued subagent spawn from 04-lfp',
	}

	const lines = blocks.renderBlock(block, 100).map((l) => stripAnsi(l))
	const header = lines[0] ?? ''
	const body = lines.slice(1).join('\n')

	expect(header).toContain('Spawn agent')
	expect(body).toContain('task: `Design the benchmark prompt')
	expect(body).toContain("mode: 'fresh'")
	expect(body).toContain("model: 'openai/gpt-5.4'")
	expect(body).toContain("cwd: '/Users/antti/.hal'")
	expect(body).toContain("title: 'edit benchmark prompt'")
	expect(body).toContain('closeWhenDone: false')
	expect(body).toContain('Queued subagent spawn from 04-lfp')
})

test('grep block quotes its search pattern in header', () => {
	const block: Block = {
		type: 'tool',
		name: 'grep',
		input: { pattern: 'const MODEL_GROUPS', path: '/Users/antti/.hal/src' },
	}

	const header = stripAnsi(blocks.renderBlock(block, 100)[0] ?? '')
	expect(header).toContain('Grep "const MODEL_GROUPS" in /Users/antti/.hal/src')
})

test('eval block separates returned output from code', () => {
	const block: Block = {
		type: 'tool',
		name: 'eval',
		input: { code: 'let count = 0\nif (count === 0) {\n\treturn count\n}' },
		output: '0',
	}

	const body = blocks.renderBlock(block, 100).map((l) => stripAnsi(l)).slice(1)
	expect(body).toEqual([
		'let count = 0',
		'if (count === 0) {',
		'\treturn count',
		'}',
		'── Result ──────────────────────────────────────────────────────────────────────────────────────────',
		'0',
	])
})

test('eval block omits result separator when there is no returned output', () => {
	const block: Block = {
		type: 'tool',
		name: 'eval',
		input: { code: 'let count = 0' },
	}

	const body = blocks.renderBlock(block, 100).map((l) => stripAnsi(l)).slice(1)
	expect(body).toEqual(['let count = 0'])
})

test('bash block still uses continuation backslashes for multiline commands', () => {
	const block: Block = {
		type: 'tool',
		name: 'bash',
		input: { command: 'echo one\necho two' },
	}

	const body = blocks.renderBlock(block, 100).map((l) => stripAnsi(l)).slice(1)
	expect(body).toEqual(['echo one \\', 'echo two'])
})

test('bash block strips redundant cd prefix for the current cwd', () => {
	const block: Block = {
		type: 'tool',
		name: 'bash',
		input: { command: 'cd /Users/antti/.hal && git status', cwd: '/Users/antti/.hal/' },
	}

	const header = stripAnsi(blocks.renderBlock(block, 100)[0] ?? '')
	expect(header).toContain('Bash: git status')
	expect(header).not.toContain('cd /Users/antti/.hal')
})

test('bash git commit renders rich commit details instead of shell plumbing', () => {
	const block: Block = {
		type: 'tool',
		name: 'bash',
		input: { command: 'cd /Users/antti/.hal && git commit -m "Nice title\n\nGenerated by test"', cwd: '/Users/antti/.hal' },
		output: `[main abc123] Nice title
[hal-commit]
{
	branch: 'main',
	hash: 'abc123',
	message: 'Nice title\n\nGenerated by test',
	summary: '2 files changed, 3 insertions(+), 1 deletion(-)',
	files: [
		{ path: 'src/a.test.ts', added: 2, removed: 0, locDelta: 1, isCode: false },
		{ path: 'src/a.ts', added: 1, removed: 1, locDelta: 0, isCode: true }
	],
	locDelta: 1,
	locDeltaCode: 0
}
[/hal-commit]`,
	}

	const raw = blocks.renderBlock(block, 100)
	const lines = raw.map((l) => stripAnsi(l))
	expect(lines[0]).toContain('Commit abc123: Nice title')
	expect(lines).toContain('Generated by test')
	expect(lines).toContain('main abc123 · 2 files changed, 3 insertions(+), 1 deletion(-)')
	expect(lines).toContain('Tests / docs / other')
	expect(lines).toContain('   2 −0   src/a.test.ts')
	expect(lines).toContain('Code')
	expect(lines).toContain('   1 −1   src/a.ts  0 loc')
	expect(lines).toContain('Net LOC: +1 total, 0 excluding tests')
	expect(raw.join('\n')).toContain('\x1b[1m0 excluding tests\x1b[22m')
	expect(lines.join('\n')).not.toContain('[main abc123]')
	expect(lines.join('\n')).not.toContain('cd /Users/antti/.hal')
})

test('bash git commit -F renders from metadata message', () => {
	const block: Block = {
		type: 'tool',
		name: 'bash',
		input: { command: "git commit -F - <<'EOF'\nFile title\n\nFile body\nEOF" },
		output: `[main def456] File title
[hal-commit]
{
	branch: 'main',
	hash: 'def456',
	message: 'File title\n\nFile body',
	summary: '1 file changed, 1 insertion(+)',
	files: [
		{ path: 'src/a.ts', added: 1, removed: 0, locDelta: 1, isCode: true }
	],
	locDelta: 1,
	locDeltaCode: 1
}
[/hal-commit]`,
	}

	const lines = blocks.renderBlock(block, 100).map((l) => stripAnsi(l))
	expect(lines[0]).toContain('Commit def456: File title')
	expect(lines).toContain('File body')
	expect(lines).toContain('main def456 · 1 file changed, 1 insertion(+)')
	expect(lines.join('\n')).not.toContain('[hal-commit]')
	expect(lines.join('\n')).not.toContain('git commit -F')
})

test('failed shell-substitution commit renders as ordinary bash', () => {
	const block: Block = {
		type: 'tool',
		name: 'bash',
		input: { command: "git commit -m \"$(cat <<'EOF'\nBad title\nEOF\n)\"" },
		output: 'bash: unexpected EOF while looking for matching `\'\'\n',
	}

	const lines = blocks.renderBlock(block, 100).map((l) => stripAnsi(l))
	expect(lines[0]).toContain('Bash')
	expect(lines[0]).not.toContain('Commit')
	expect(lines.join('\n')).toContain("git commit -m")
	expect(lines.join('\n')).toContain('bash: unexpected EOF')
})

test('edit block header shows affected hashline refs', () => {
	const block: Block = {
		type: 'tool',
		name: 'edit',
		input: {
			path: 'src/app.ts',
			operation: 'replace',
			start_ref: '12:abc',
			end_ref: '15:def',
			new_content: 'next',
		},
	}

	const header = stripAnsi(blocks.renderBlock(block, 100)[0] ?? '')
	expect(header).toContain('Edit src/app.ts (12:abc-15:def)')
})

test('edit block shows hashline refs for debugging', () => {
	const block: Block = {
		type: 'tool',
		name: 'edit',
		input: {
			path: 'src/app.ts',
			operation: 'replace',
			start_ref: '12:abc',
			end_ref: '15:def',
			new_content: 'next',
		},
	}

	const body = blocks
		.renderBlock(block, 100)
		.map((l) => stripAnsi(l))
		.slice(1)
		.join('\n')
	expect(body).toContain("operation: 'replace'")
	expect(body).toContain("start_ref: '12:abc'")
	expect(body).toContain("end_ref: '15:def'")
})

test('edit block keeps failure details visible after diff preview', () => {
	const block: Block = {
		type: 'tool',
		name: 'edit',
		output: [
			'--- before',
			'2:aaa old line',
			'',
			'+++ after',
			'2:bbb new line',
			'',
			'TypeScript check failed for src/app.ts:',
			'error TS2322: Type string is not assignable to number.',
		].join('\n'),
	}

	const body = blocks
		.renderBlock(block, 100)
		.map((l) => stripAnsi(l))
		.slice(1)
		.join('\n')
	expect(body).toContain('− 2:aaa old line')
	expect(body).toContain('+ 2:bbb new line')
	expect(body).toContain('TypeScript check failed for src/app.ts:')
	expect(body).toContain('error TS2322: Type string is not assignable to number.')
})
