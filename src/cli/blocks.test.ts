import { expect, test } from 'bun:test'
import { blocks, type Block } from './blocks.ts'

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
	const clean = lines.map(l => stripAnsi(l))

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


test('thinking header includes model and default thinking level', () => {
	const block: Block = {
		type: 'thinking',
		text: 'hmm',
		model: 'gpt-5.4',
	}

	const header = stripAnsi(blocks.renderBlock(block, 80)[0] ?? '')
	expect(header).toContain('Hal (GPT 5.4, thinking high)')
})


test('historyToBlocks carries model changes into later assistant and thinking blocks', () => {
	const history: any[] = [
		{ type: 'session', action: 'model', new: 'openai/gpt-5.4', ts: '2026-04-15T14:54:00.000Z' },
		{ type: 'thinking', text: 'hmm', ts: '2026-04-15T14:54:01.000Z' },
		{ type: 'assistant', text: 'done', ts: '2026-04-15T14:54:02.000Z' },
	]

	const rendered = blocks.historyToBlocks(history as any, 's1')
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


test('forked_from history entry renders as a Fork block', () => {
	const history: any[] = [
		{ type: 'forked_from', parent: '04-abc', ts: '2026-04-09T20:00:00.000Z' },
	]

	const result = blocks.historyToBlocks(history as any, 'child')
	expect(result).toMatchObject([{ type: 'fork', text: 'Forked from 04-abc' }])
	const lines = blocks.renderBlock(result[0]!, 80)
	expect(stripAnsi(lines[0] ?? '')).toContain('Fork')
})


test('startup block renders a Startup header', () => {
	const block: Block = {
		type: 'startup',
		text: 'Server started (pid 123) · ready 99.9ms',
		ts: new Date('2026-01-01T17:39:00Z').getTime(),
	}

	const lines = blocks.renderBlock(block, 80)
	expect(stripAnsi(lines[0] ?? '')).toContain('Startup')
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

	const body = blocks.renderBlock(block, 100).map((l) => stripAnsi(l)).slice(1).join('\n')
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

	const body = blocks.renderBlock(block, 100).map((l) => stripAnsi(l)).slice(1).join('\n')
	expect(body).toContain('− 2:aaa old line')
	expect(body).toContain('+ 2:bbb new line')
	expect(body).toContain('TypeScript check failed for src/app.ts:')
	expect(body).toContain('error TS2322: Type string is not assignable to number.')
})
