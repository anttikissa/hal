import { describe, test, expect } from 'bun:test'
import { renderBlocks, type Block } from './blocks.ts'

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '')

function trimLine(s: string): string {
	return strip(s).trim()
}

describe('renderBlocks', () => {
	test('single input block', () => {
		const blocks: Block[] = [{ type: 'input', text: 'hello' }]
		const lines = renderBlocks(blocks, 80)
		expect(trimLine(lines[0])).toMatch(/^── You ─+$/)
		expect(lines[1]).toContain('hello')
	})

	test('[system] prefix renders as System header', () => {
		const blocks: Block[] = [{ type: 'input', text: '[system] Session was reset.' }]
		const lines = renderBlocks(blocks, 80)
		expect(trimLine(lines[0])).toMatch(/^── System ─+$/)
		expect(trimLine(lines[1])).toContain('Session was reset.')
	})

	test('assistant leading blank lines are removed', () => {
		const blocks: Block[] = [{ type: 'assistant', text: '\n\nhello', done: true }]
		const lines = renderBlocks(blocks, 80)
		expect(trimLine(lines[1])).toBe('hello')
	})

	test('thinking short text stays plain (no header)', () => {
		const blocks: Block[] = [{ type: 'thinking', text: 'short\nthought', done: false, model: 'openai/gpt-5.3-codex' }]
		const lines = renderBlocks(blocks, 80)
		expect(lines.some(l => trimLine(l).startsWith('── Hal ('))).toBe(false)
		expect(lines.some(l => l.includes('short'))).toBe(true)
	})

	test('thinking long text uses the block model in header', () => {
		const text = Array.from({ length: 14 }, (_, i) => `line ${i}`).join('\n')
		const blocks: Block[] = [{ type: 'thinking', text, done: false, ref: 'abc123', model: 'anthropic/claude-sonnet-4-20250514', sessionId: '02-xyz' }]
		const lines = renderBlocks(blocks, 80)
		expect(lines.some(l => trimLine(l).includes('Hal (Sonnet 4, thinking)'))).toBe(true)
		expect(lines.some(l => trimLine(l).includes('[+ 4 lines]'))).toBe(true)
		expect(lines.some(l => trimLine(l).includes('[02-xyz/abc123]'))).toBe(true)
	})

	test('bash long command is moved below header', () => {
		const longCmd = 'echo ' + 'x'.repeat(80)
		const blocks: Block[] = [
			{ type: 'tool', name: 'bash', status: 'done', args: longCmd, output: '', startTime: Date.now(), endTime: Date.now() },
		]
		const lines = renderBlocks(blocks, 80)
		expect(trimLine(lines[0])).toMatch(/^── bash: \(0\.0s\) :ok: /)
		expect(lines[1]).toContain('echo')
	})

	test('tool error in header uses cross', () => {
		const blocks: Block[] = [
			{ type: 'tool', name: 'read', status: 'error', args: 'foo.txt', output: 'error: not found', startTime: Date.now() - 1000 },
		]
		const lines = renderBlocks(blocks, 80)
		expect(lines[0]).toContain('✗')
	})

	test('all block lines keep width', () => {
		const blocks: Block[] = [
			{ type: 'assistant', text: 'hello', done: true },
			{ type: 'tool', name: 'bash', status: 'done', args: 'ls', output: 'ok', startTime: Date.now() - 1000, endTime: Date.now() },
		]
		const lines = renderBlocks(blocks, 40)
		for (const line of lines.filter(Boolean)) {
			expect(strip(line).length).toBeLessThanOrEqual(40)
		}
	})

	test('long tool header stays within width', () => {
		const longArgs = 'padTarget|pad.*target|lines\\.push|scroll|content.*height|visible.*lines (0.0s) ✓'
		const blocks: Block[] = [
			{ type: 'tool', name: 'grep', status: 'done', args: longArgs, output: 'No matches found.', startTime: Date.now() - 500, endTime: Date.now(), ref: '008sp9-ybs', sessionId: '02-f17' },
		]
		for (const w of [80, 90, 100, 120]) {
			const lines = renderBlocks(blocks, w)
			for (const line of lines.filter(Boolean)) {
				expect(strip(line).length).toBeLessThanOrEqual(w)
			}
		}
	})
})
