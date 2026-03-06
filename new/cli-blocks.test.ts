import { describe, test, expect } from 'bun:test'
import { renderBlocks, type Block } from './cli-blocks.ts'

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')

describe('renderBlocks', () => {
	test('empty blocks → empty', () => {
		expect(renderBlocks([], 80)).toEqual([])
	})

	test('single input block', () => {
		const blocks: Block[] = [{ type: 'input', text: 'hello' }]
		const lines = renderBlocks(blocks, 80)
		expect(lines.length).toBe(1)
		expect(lines[0]).toContain('you: hello')
	})

	test('queued input renders compact', () => {
		const blocks: Block[] = [{ type: 'input', text: 'fix bug', status: 'queued' }]
		const lines = renderBlocks(blocks, 80)
		expect(lines.length).toBe(1)
		expect(lines[0]).toContain('(queued)')
		expect(lines[0]).toContain('fix bug')
	})

	test('blank line between blocks', () => {
		const blocks: Block[] = [
			{ type: 'input', text: 'hi' },
			{ type: 'assistant', text: 'hello', done: true },
		]
		const lines = renderBlocks(blocks, 80)
		// input line, blank, assistant line
		expect(lines.length).toBe(3)
		expect(lines[1]).toBe('')
	})

	test('thinking collapses when done', () => {
		const blocks: Block[] = [
			{ type: 'thinking', text: 'long thought\n\nmore thought', done: true },
		]
		const lines = renderBlocks(blocks, 80)
		expect(lines.length).toBe(1)
		expect(lines[0]).toContain('Thinking...')
	})

	test('thinking shows content while streaming', () => {
		const blocks: Block[] = [
			{ type: 'thinking', text: 'analyzing...', done: false },
		]
		const lines = renderBlocks(blocks, 80)
		expect(lines.some(l => l.includes('analyzing'))).toBe(true)
	})

	test('assistant collapses triple newlines', () => {
		const blocks: Block[] = [
			{ type: 'assistant', text: 'para1\n\n\n\npara2', done: true },
		]
		const lines = renderBlocks(blocks, 80)
		// Should be: para1, blank, para2 (not para1, blank, blank, blank, para2)
		expect(lines).toEqual(['para1', '', 'para2'])
	})

	test('tool header with ─ fill', () => {
		const blocks: Block[] = [
			{ type: 'tool', name: 'bash', status: 'running', args: 'ls', output: '', startTime: Date.now() },
		]
		const lines = renderBlocks(blocks, 40)
		const plain = strip(lines[0])
		expect(plain).toMatch(/^── bash: ls .+─+$/)
		expect(plain.length).toBe(40)
	})

	test('tool header wraps long commands', () => {
		const longCmd = 'a'.repeat(100)
		const blocks: Block[] = [
			{ type: 'tool', name: 'bash', status: 'running', args: longCmd, output: '', startTime: Date.now() },
		]
		const lines = renderBlocks(blocks, 40)
		expect(lines.length).toBeGreaterThan(1)
		// Last header line ends with ─ fill
		const lastPlain = strip(lines[lines.length - 1])
		expect(lastPlain).toMatch(/─+$/)
	})

	test('tool output collapses after 5 lines', () => {
		const output = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
		const blocks: Block[] = [
			{ type: 'tool', name: 'bash', status: 'done', args: 'cmd', output, startTime: Date.now() - 2000 },
		]
		const lines = renderBlocks(blocks, 80)
		const plain = lines.map(l => strip(l))
		expect(plain.some(l => l.includes('[+ 5 lines]'))).toBe(true)
		// Shows last 5 lines
		expect(plain.some(l => l.includes('line 9'))).toBe(true)
		expect(plain.some(l => l.includes('line 5'))).toBe(true)
		// Does NOT show early lines
		expect(plain.some(l => l.includes('line 0'))).toBe(false)
	})

	test('tool done shows checkmark in header', () => {
		const blocks: Block[] = [
			{ type: 'tool', name: 'bash', status: 'done', args: 'ls', output: 'ok', startTime: Date.now() - 2000 },
		]
		const lines = renderBlocks(blocks, 80)
		expect(lines[0]).toContain('✓')
	})

	test('tool error shows cross in header', () => {
		const blocks: Block[] = [
			{ type: 'tool', name: 'read', status: 'error', args: 'foo.txt', output: 'not found', startTime: Date.now() - 1000 },
		]
		const lines = renderBlocks(blocks, 80)
		expect(lines[0]).toContain('✗')
	})

	test('tool block lines are full width', () => {
		const blocks: Block[] = [
			{ type: 'tool', name: 'bash', status: 'done', args: 'ls', output: 'hi', startTime: Date.now() },
		]
		const lines = renderBlocks(blocks, 40)
		for (const line of lines) {
			expect(strip(line).length).toBe(40)
		}
	})

	test('empty assistant block produces no lines', () => {
		const blocks: Block[] = [
			{ type: 'input', text: 'hi' },
			{ type: 'assistant', text: '', done: false },
		]
		const lines = renderBlocks(blocks, 80)
		expect(lines.length).toBe(1)
		expect(lines[0]).toContain('you: hi')
	})
})
