import { describe, test, expect } from 'bun:test'
import { renderBlocks, type Block } from './cli-blocks.ts'

describe('renderBlocks', () => {
	test('empty blocks → empty', () => {
		expect(renderBlocks([], 80)).toEqual([])
	})

	test('single input block', () => {
		const blocks: Block[] = [{ type: 'input', text: 'hello' }]
		const lines = renderBlocks(blocks, 80)
		expect(lines.length).toBe(1)
		expect(lines[0]).toContain('> hello')
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

	test('tool done shows checkmark', () => {
		const blocks: Block[] = [
			{ type: 'tool', name: 'bash', status: 'done', args: '', output: 'ok', startTime: Date.now() - 2000 },
		]
		const lines = renderBlocks(blocks, 80)
		expect(lines[0]).toContain('bash')
		expect(lines[0]).toContain('✓')
	})

	test('tool error shows cross', () => {
		const blocks: Block[] = [
			{ type: 'tool', name: 'read', status: 'error', args: '', output: 'not found', startTime: Date.now() - 1000 },
		]
		const lines = renderBlocks(blocks, 80)
		expect(lines[0]).toContain('✗')
		expect(lines[0]).toContain('not found')
	})

	test('empty assistant block produces no lines', () => {
		const blocks: Block[] = [
			{ type: 'input', text: 'hi' },
			{ type: 'assistant', text: '', done: false },
		]
		const lines = renderBlocks(blocks, 80)
		// Empty assistant block should be skipped, no trailing blank line
		expect(lines.length).toBe(1)
		expect(lines[0]).toContain('> hi')
	})
})
