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


test('tool output escapes terminal control bytes', () => {
	const block: Block = {
		type: 'tool',
		name: 'read',
		output: 'ok\r\n\x1b[2K\x1bHboom',
	}

	const lines = blocks.renderBlock(block, 80)
	const joined = lines.join('\n')
	const clean = lines.map((l) => stripAnsi(l)).join('\n')

	expect(joined).not.toContain('\x1b[2K')
	expect(joined).not.toContain('\x1bH')
	expect(joined).not.toContain('\rboom')
	expect(clean).toContain('␍')
	expect(clean).toContain('␛[2K␛Hboom')
})
