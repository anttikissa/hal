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
