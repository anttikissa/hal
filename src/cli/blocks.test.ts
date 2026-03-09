import { describe, test, expect } from 'bun:test'
import { renderBlocks, type Block } from './blocks.ts'

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
describe('renderBlocks', () => {
	test('empty blocks → empty', () => {
		expect(renderBlocks([], 80)).toEqual([])
	})

	test('single input block', () => {
		const blocks: Block[] = [{ type: 'input', text: 'hello' }]
		const lines = renderBlocks(blocks, 80)
		// header + body + blank + idle cursor
		expect(lines.length).toBe(4)
		expect(strip(lines[0])).toMatch(/^── You ─+$/)
		expect(lines[1]).toContain('hello')
	})

	test('[system] prefix renders as System header', () => {
		const blocks: Block[] = [{ type: 'input', text: '[system] Session was reset.' }]
		const lines = renderBlocks(blocks, 80)
		expect(strip(lines[0])).toMatch(/^── System ─+$/)
		expect(strip(lines[1])).toContain('Session was reset.')
		expect(strip(lines[1])).not.toContain('[system]')
	})

	test('input block shows model name', () => {
		const blocks: Block[] = [{ type: 'input', text: 'fix it', model: 'codex-5.3' }]
		const lines = renderBlocks(blocks, 80)
		expect(strip(lines[0])).toMatch(/^── You \(to codex-5\.3\) ─+$/)
		expect(lines[1]).toContain('fix it')
	})
	test('queued input renders compact', () => {
		const blocks: Block[] = [{ type: 'input', text: 'fix bug', status: 'queued' }]
		const lines = renderBlocks(blocks, 80)
		expect(lines.length).toBe(3) // compact + blank + idle cursor
		expect(lines[0]).toContain('(queued)')
		expect(lines[0]).toContain('fix bug')
	})

	test('blank line between blocks', () => {
		const blocks: Block[] = [
			{ type: 'input', text: 'hi' },
			{ type: 'assistant', text: 'hello', done: true },
		]
		const lines = renderBlocks(blocks, 80)
		// input header, input body, blank, assistant header, assistant body, blank, idle cursor
		expect(lines.length).toBe(7)
		expect(lines[2]).toBe('')
	})

	test('thinking shows full text when done', () => {
		const blocks: Block[] = [
			{ type: 'thinking', text: 'long thought\n\nmore thought', done: true },
		]
		const lines = renderBlocks(blocks, 80)
		expect(lines.length).toBe(5) // 3 content + blank + idle cursor
		expect(lines.some(l => l.includes('long thought'))).toBe(true)
		expect(lines.some(l => l.includes('more thought'))).toBe(true)
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
		const plain = lines.slice(0, -2).map(l => strip(l).trim())
		// header, para1, blank, para2 (not para1, blank, blank, blank, para2)
		expect(plain.length).toBe(4)
		expect(plain[1]).toBe('para1')
		expect(plain[2]).toBe('')
		expect(plain[3]).toBe('para2')
	})

	test('tool header with ─ fill', () => {
		const blocks: Block[] = [
			{ type: 'tool', name: 'bash', status: 'done', args: 'ls', output: '', startTime: Date.now(), endTime: Date.now() },
		]
		const lines = renderBlocks(blocks, 40)
		const plain = strip(lines[0])
		expect(plain).toMatch(/^── bash: ls .+─+$/)
		expect(plain.length).toBe(40)
	})

	test('tool header wraps long commands', () => {
		const longCmd = 'a'.repeat(50)
		const blocks: Block[] = [
			{ type: 'tool', name: 'bash', status: 'done', args: longCmd, output: '', startTime: Date.now(), endTime: Date.now() },
		]
		const lines = renderBlocks(blocks, 40)
		expect(lines.length).toBeGreaterThan(3) // header lines + blank + idle cursor
		const contentLines = lines.slice(0, -2)
		const lastPlain = strip(contentLines[contentLines.length - 1])
		expect(lastPlain).toMatch(/─+\s*$/)
	})

	test('running tool shows inline cursor', () => {
		const blocks: Block[] = [
			{ type: 'tool', name: 'bash', status: 'running', args: 'ls', output: 'file.txt', startTime: Date.now() },
		]
		const lines = renderBlocks(blocks, 40, true)
		// Cursor should be on the last output line, not a separate line
		const lastContentLine = strip(lines[lines.length - 1])
		expect(lastContentLine).toContain('file.txt')
		expect(lastContentLine).toContain('█')
		expect(lastContentLine.length).toBe(40)
	})

	test('streaming assistant line keeps full width with inline cursor', () => {
		const blocks: Block[] = [
			{ type: 'assistant', text: 'Done!', done: false, model: 'mock' },
		]
		const lines = renderBlocks(blocks, 40, true)
		const bodyLine = strip(lines[1])
		expect(bodyLine).toContain('Done!')
		expect(bodyLine).toContain('█')
		expect(bodyLine.length).toBe(40)
	})

	test('running tool header with inline cursor moves to next line when header is full width', () => {
		const blocks: Block[] = [
			{ type: 'tool', name: 'read', status: 'running', args: 'package.json', output: '', startTime: Date.now() },
		]
		const lines = renderBlocks(blocks, 40, true)
		expect(strip(lines[0])).not.toContain('█')
		expect(strip(lines[0]).length).toBe(40)
		expect(strip(lines[1])).toContain('█')
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
		for (const line of lines.slice(0, -2)) {
			expect(strip(line).length).toBe(40)
		}
	})

	test('tool output with tabs expands to spaces at correct width', () => {
		const output = '\t"key": "value"'
		const blocks: Block[] = [
			{ type: 'tool', name: 'read', status: 'done', args: 'f.json', output, startTime: Date.now() },
		]
		const lines = renderBlocks(blocks, 40)
		const outputLine = lines.find(l => l.includes('"key"'))!
		// Tabs expanded to spaces — no literal tabs
		expect(outputLine).not.toContain('\t')
		// 4 spaces for tab + BLOCK_PAD(1) = 5 spaces before "key"
		expect(strip(outputLine)).toMatch(/^ {5}"key"/)
		// Full width padded correctly
		expect(strip(outputLine).length).toBe(40)
	})

	test('empty assistant block produces no lines', () => {
		const blocks: Block[] = [
			{ type: 'input', text: 'hi' },
			{ type: 'assistant', text: '', done: false },
		]
		const lines = renderBlocks(blocks, 80)
		expect(lines.length).toBe(2)
		expect(strip(lines[0])).toMatch(/^── You ─+$/)
		expect(lines[1]).toContain('hi')
	})

	test('word wraps long text at word boundaries', () => {
		const text = 'the quick brown fox jumps over the lazy dog and keeps running'
		const blocks: Block[] = [{ type: 'assistant', text, done: true }]
		// width 30, BLOCK_PAD=1 each side → content width 28
		const lines = renderBlocks(blocks, 30)
		const body = lines.slice(1).map(l => strip(l).trim()).filter(Boolean)
		// Each line should be <= 28 visible chars (content width)
		for (const b of body) expect(b.length).toBeLessThanOrEqual(28)
		// All words should appear across the lines
		for (const word of text.split(' ')) {
			expect(body.some(l => l.includes(word))).toBe(true)
		}
		// Lines should break at spaces, not mid-word
		expect(body.length).toBeGreaterThan(1)
	})

	test('right padding on assistant blocks', () => {
		const blocks: Block[] = [{ type: 'assistant', text: 'hi', done: true }]
		const lines = renderBlocks(blocks, 40)
		// Body line: BLOCK_PAD(1) left + "hi" + padding to fill 40 cols
		const bodyPlain = strip(lines[1])
		expect(bodyPlain.length).toBe(40)
		// Should start with space (left pad) and end with spaces (right pad)
		expect(bodyPlain[0]).toBe(' ')
		expect(bodyPlain[bodyPlain.length - 1]).toBe(' ')
	})

	test('info block renders with neutral styling', () => {
		const blocks: Block[] = [{ type: 'info', text: 'Context window >66% full' }]
		const lines = renderBlocks(blocks, 80)
		// body + blank + idle cursor
		expect(lines.length).toBe(3)
		expect(lines[0]).toContain('Context window >66% full')
	})

	test('info block is full width', () => {
		const blocks: Block[] = [{ type: 'info', text: 'paused' }]
		const lines = renderBlocks(blocks, 40)
		expect(strip(lines[0]).length).toBe(40)
	})

	test('error block renders with header and body', () => {
		const blocks: Block[] = [{ type: 'error', text: 'API request failed', detail: 'status 400: invalid content' }]
		const lines = renderBlocks(blocks, 80)
		// header + body line + blank + idle cursor = 4
		expect(lines.length).toBe(4)
		expect(strip(lines[0])).toContain('Error')
		expect(strip(lines[1])).toContain('status 400: invalid content')
	})

	test('error block without detail renders header + message', () => {
		const blocks: Block[] = [{ type: 'error', text: 'Something went wrong' }]
		const lines = renderBlocks(blocks, 80)
		// header + body + blank + cursor = 4
		expect(lines.length).toBe(4)
		expect(strip(lines[0])).toContain('Error')
		expect(strip(lines[1])).toContain('Something went wrong')
	})

	test('error block is full width', () => {
		const blocks: Block[] = [{ type: 'error', text: 'fail' }]
		const lines = renderBlocks(blocks, 40)
		expect(strip(lines[0]).length).toBe(40)
	})

	test('tool header shows ref at end', () => {
		const blocks: Block[] = [
			{ type: 'tool', name: 'bash', status: 'done', args: 'ls', output: 'ok',
				startTime: Date.now() - 1000, endTime: Date.now(), ref: '001abc-xyz' },
		]
		const lines = renderBlocks(blocks, 80)
		const plain = strip(lines[0])
		expect(plain).toContain('[001abc-xyz]')
		// Ref should be at the very end of the header
		expect(plain).toMatch(/─+ \[001abc-xyz\] ──$/)
		expect(plain.length).toBe(80)
	})

	test('tool header without ref has no brackets', () => {
		const blocks: Block[] = [
			{ type: 'tool', name: 'bash', status: 'done', args: 'ls', output: 'ok',
				startTime: Date.now() - 1000, endTime: Date.now() },
		]
		const lines = renderBlocks(blocks, 80)
		const plain = strip(lines[0])
		expect(plain).not.toContain('[')
	})

	test('error block with ref shows ref in header', () => {
		const blocks: Block[] = [
			{ type: 'error', text: 'fail', detail: 'details', ref: '002def-abc' },
		]
		const lines = renderBlocks(blocks, 80)
		const plain = strip(lines[0])
		expect(plain).toContain('[002def-abc]')
	})

	test('error block formats JSON detail with ason.stringify', () => {
		const detail = '{"error":{"type":"invalid_request","message":"bad input"}}'
		const blocks: Block[] = [{ type: 'error', text: 'API error', detail }]
		const lines = renderBlocks(blocks, 80)
		const body = lines.slice(1, -2).map(l => strip(l).trim())
		// Should be formatted, not raw JSON
		expect(body.some(l => l.includes('error:'))).toBe(true)
	})
})