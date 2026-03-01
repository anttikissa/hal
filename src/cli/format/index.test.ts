import { describe, test, expect } from 'bun:test'
import { pushFragment, pushEvent, resetFormat } from './index.ts'
import { loadActiveTheme } from './theme.ts'
import { stripAnsi } from './index.ts'

const RESET = '\x1b[0m'

describe('cli format index', () => {
	test('chunk transition prefix uses RESET first and newline between channels', () => {
		resetFormat('s1')
		const first = pushFragment('chunk.assistant', 'hello', 's1')
		expect(first.startsWith(RESET)).toBe(true)

		const secondSameKind = pushFragment('chunk.assistant', 'world', 's1')
		expect(secondSameKind.startsWith('\n')).toBe(false)
		expect(secondSameKind.startsWith(RESET)).toBe(false)

		const thirdDifferentKind = pushFragment('chunk.thinking', 'hmm', 's1')
		expect(thirdDifferentKind.startsWith('\n')).toBe(true)
	})

	test('line styles are applied per line including multi-line content', () => {
		loadActiveTheme(process.cwd(), 'default')
		resetFormat('s2')
		const out = pushFragment('line.warn', 'one\ntwo', 's2')
		expect(out).toContain('\x1b[33mone\x1b[0m\n\x1b[33mtwo\x1b[0m')
		expect(out.endsWith('\n')).toBe(true)
	})

	test('prefix styling keeps remainder styled after prefix reset', () => {
		loadActiveTheme(process.cwd(), 'default')
		resetFormat('s3')
		const out = pushFragment('line.tool', '[tool] done', 's3')
		expect(out).toContain('\x1b[0m\x1b[36mdone')
	})
})

describe('consecutive block spacing', () => {
	test('one blank line between consecutive prompt blocks', () => {
		resetFormat('blk1')
		const first = pushFragment('prompt', 'first message', 'blk1')
		const second = pushFragment('prompt', 'second message', 'blk1')

		// blockEnd \n + blockStart \n = 1 blank line
		// Bar ANSI codes separate newlines, so no raw triple-\n exists
		expect(first + second).not.toMatch(/\n{3,}/)
	})

	test('no double blank between queued and steering prompt', () => {
		resetFormat('blk2')
		pushFragment('prompt', '[queued] msg', 'blk2')
		const steering = pushFragment('prompt.steering', '[steering] msg', 'blk2')

		// Redraw fires — starts with escape, not bare \n
		expect(steering).not.toMatch(/^\n/)
	})

	test('prompt after non-block line still has blank line separator', () => {
		resetFormat('blk3')
		pushFragment('line.info', 'some info', 'blk3')
		const prompt = pushFragment('prompt', 'my message', 'blk3')

		expect(prompt).toMatch(/^\n/)
	})

	test('one blank line before steering even with events between', () => {
		resetFormat('blk4')
		pushFragment('prompt', 'you can push changes', 'blk4')
		pushFragment('chunk.assistant', 'model output', 'blk4')
		pushFragment('line.warn', '[context] warning', 'blk4')
		const steering = pushFragment('prompt.steering', '[steering] steer', 'blk4')

		// blockStart always has single leading \n — never double
		expect(steering).toMatch(/^\n/)
		expect(steering).not.toMatch(/^\n\n/)
	})

	test('blank line before first chunk after prompt', () => {
		resetFormat('blk5')
		pushFragment('prompt', 'user question', 'blk5')
		const thinking = pushFragment('chunk.thinking', 'Let me think...', 'blk5')

		// One blank line between prompt block and thinking chunk
		expect(thinking).toMatch(/^\n/)
	})

	test('blank line before assistant chunk after prompt', () => {
		resetFormat('blk6')
		pushFragment('prompt', 'user question', 'blk6')
		const assistant = pushFragment('chunk.assistant', 'Sure!', 'blk6')

		expect(assistant).toMatch(/^\n/)
	})
})

describe('trailing-newline-aware spacing', () => {
	test('notice block + prompt block: exactly one blank line', () => {
		resetFormat('tnl1')
		pushFragment('chunk.assistant', 'some response\n', 'tnl1')
		const notice = pushFragment('line.notice', '[context] >66% full', 'tnl1')
		const prompt = pushFragment('prompt', 'user message', 'tnl1')
		// Between notice bottom bar and prompt top bar: exactly one blank line
		const combined = notice + prompt
		const plain = stripAnsi(combined)
		const lines = plain.split('\n')
		// Find the gap between notice and prompt content
		const noticeEnd = lines.findIndex(l => l.includes('>66%'))
		const promptStart = lines.findIndex((l, i) => i > noticeEnd && l.includes('user message'))
		// Should have exactly 3 lines between: bar, blank, bar
		expect(promptStart - noticeEnd).toBeLessThanOrEqual(4)
		expect(promptStart - noticeEnd).toBeGreaterThanOrEqual(3)
	})

	test('tool output with trailing newline: one blank line before next section', () => {
		resetFormat('tnl2')
		pushFragment('line.tool', '[bash] echo hi', 'tnl2')
		const tool = pushFragment('line.tool', 'hi\n', 'tnl2')
		const chunk = pushFragment('chunk.assistant', 'Done.', 'tnl2')
		// Combined: tool ends with \n, sep adds \n → exactly \n\n = one blank line
		const combined = stripAnsi(tool + chunk)
		expect(combined).toMatch(/hi\n\n.*Done\./)
		expect(combined).not.toMatch(/hi\n\n\n/)
	})

	test('chunk ending with newline (block_stop): one blank line before block', () => {
		resetFormat('tnl3')
		pushFragment('chunk.assistant', 'text content', 'tnl3')
		pushFragment('chunk.assistant', '\n', 'tnl3')
		const notice = pushFragment('line.notice', '[context] warning', 'tnl3')
		// Should start with exactly 1 blank line gap, not 2
		expect(notice).toMatch(/^\n[^\n]/)
	})

	test('tool output without trailing newline: still one blank line', () => {
		resetFormat('tnl4')
		pushFragment('line.tool', '[bash] echo hi', 'tnl4')
		const tool = pushFragment('line.tool', 'hi', 'tnl4')
		const chunk = pushFragment('chunk.assistant', 'Done.', 'tnl4')
		// Combined: tool ends with \n, sep adds \n → exactly \n\n
		const combined = stripAnsi(tool + chunk)
		expect(combined).toMatch(/hi\n\n.*Done\./)
		expect(combined).not.toMatch(/hi\n\n\n/)
	})

	test('assistant text in history replay: one blank line after prompt', () => {
		resetFormat('tnl5')
		const prompt = pushFragment('prompt', 'question', 'tnl5')
		const reply = pushFragment('assistant', 'answer text', 'tnl5')
		const combined = prompt + reply
		const plain = stripAnsi(combined)
		// Count blank lines between prompt block end and answer
		const lines = plain.split('\n')
		const promptEnd = lines.findLastIndex(l => l.includes('question'))
		const answerStart = lines.findIndex((l, i) => i > promptEnd && l.includes('answer'))
		// Exactly: bar line, blank line, answer
		expect(answerStart - promptEnd).toBe(3)
	})
})

describe('in-place redraw for steering', () => {
	test('steering after queued prompt includes cursor-up escape', () => {
		resetFormat('rdr1')
		pushFragment('prompt', '[queued] hello', 'rdr1')
		const steering = pushFragment('prompt.steering', '[steering] hello', 'rdr1')

		// Should contain CSI cursor-up sequence: \x1b[<N>A
		expect(steering).toMatch(/\x1b\[\d+A/)
		// Should contain CSI clear-to-end: \x1b[J
		expect(steering).toContain('\x1b[J')
	})

	test('steering after queued restores leading blank line', () => {
		resetFormat('rdr2')
		pushFragment('prompt', '[queued] msg', 'rdr2')
		const steering = pushFragment('prompt.steering', '[steering] msg', 'rdr2')

		// After the cursor-up + clear, should have the full block start with \n
		// (the blank separator is restored since we're rewriting from scratch)
		const afterClear = steering.split('\x1b[J')[1] ?? ''
		expect(afterClear).toMatch(/^\n/)
	})

	test('no cursor-up when model output is between queued and steering', () => {
		resetFormat('rdr3')
		pushFragment('prompt', '[queued] msg', 'rdr3')
		pushFragment('chunk.assistant', 'model says stuff', 'rdr3')
		const steering = pushFragment('prompt.steering', '[steering] msg', 'rdr3')

		// prev is 'chunk.assistant', not 'prompt', so no cursor-up
		expect(steering).not.toMatch(/\x1b\[\d+A/)
	})

	test('no cursor-up for non-steering prompt after prompt', () => {
		resetFormat('rdr4')
		pushFragment('prompt', 'first', 'rdr4')
		const second = pushFragment('prompt', 'second', 'rdr4')

		// Two normal prompts — no redraw
		expect(second).not.toMatch(/\x1b\[\d+A/)
	})
})

describe('chunk to prompt truncation marker', () => {
	test('shows -- marker when chunk transitions to prompt', () => {
		resetFormat('trunc1')
		pushFragment('chunk.assistant', 'A daemon w', 'trunc1')
		const out = pushFragment('prompt', 'in spanish', 'trunc1')
		expect(stripAnsi(out)).toContain(' --')
	})

	test('shows -- marker when chunk transitions to steering prompt', () => {
		resetFormat('trunc2')
		pushFragment('chunk.assistant', 'The bits', 'trunc2')
		const out = pushFragment('prompt.steering', '[steering] in spanish', 'trunc2')
		expect(stripAnsi(out)).toContain(' --')
	})

	test('no -- marker when line transitions to prompt', () => {
		resetFormat('trunc3')
		pushFragment('line.info', 'some info', 'trunc3')
		const out = pushFragment('prompt', 'hello', 'trunc3')
		expect(stripAnsi(out)).not.toContain(' --')
	})

	test('no -- marker when chunk transitions to non-prompt', () => {
		resetFormat('trunc4')
		pushFragment('chunk.assistant', 'some output', 'trunc4')
		const out = pushFragment('line.info', 'info line', 'trunc4')
		expect(stripAnsi(out)).not.toContain(' --')
	})

	test('-- marker is styled in orange (warn color)', () => {
		loadActiveTheme(process.cwd(), 'default')
		resetFormat('trunc5')
		pushFragment('chunk.assistant', 'text', 'trunc5')
		const out = pushFragment('prompt', 'msg', 'trunc5')
		// Should contain the warn style (yellow in default theme) before --
		expect(out).toContain('\x1b[33m--')
	})
})

describe('prompt label rendering', () => {
	const localSource = { kind: 'cli' as const, clientId: 'test-client' }

	test('normal prompt has no prefix', () => {
		resetFormat('s4')
		const event = {
			id: '1', type: 'prompt' as const, sessionId: 's4',
			text: 'hello world', source: localSource, createdAt: '',
		}
		const out = pushEvent(event, localSource)
		expect(stripAnsi(out)).toContain('hello world')
		expect(stripAnsi(out)).not.toContain('[queued]')
		expect(stripAnsi(out)).not.toContain('[steering]')
	})

	test('queued prompt has [queued] prefix', () => {
		resetFormat('s5')
		const event = {
			id: '2', type: 'prompt' as const, sessionId: 's5',
			text: 'queued msg', label: 'queued' as const, source: localSource, createdAt: '',
		}
		const out = pushEvent(event, localSource)
		expect(stripAnsi(out)).toContain('[queued] queued msg')
	})

	test('steering prompt has [steering] prefix', () => {
		resetFormat('s6')
		const event = {
			id: '3', type: 'prompt' as const, sessionId: 's6',
			text: 'steer msg', label: 'steering' as const, source: localSource, createdAt: '',
		}
		const out = pushEvent(event, localSource)
		expect(stripAnsi(out)).toContain('[steering] steer msg')
	})

	test('steering prompt uses different fragment kind than normal/queued', () => {
		// Verify that steering goes through 'prompt.steering' kind
		// by checking the output is different from a normal prompt with same text
		resetFormat('s7')
		const normalEvent = {
			id: '4', type: 'prompt' as const, sessionId: 's7',
			text: 'same text', source: localSource, createdAt: '',
		}
		const normalOut = pushEvent(normalEvent, localSource)

		resetFormat('s8')
		const steeringEvent = {
			id: '5', type: 'prompt' as const, sessionId: 's8',
			text: 'same text', label: 'steering' as const, source: localSource, createdAt: '',
		}
		const steeringOut = pushEvent(steeringEvent, localSource)

		// Both contain the text but steering has different ANSI (different styling)
		expect(stripAnsi(normalOut)).toContain('same text')
		expect(stripAnsi(steeringOut)).toContain('[steering] same text')
		// They should not be identical (steering has prefix + potentially different style)
		expect(steeringOut).not.toBe(normalOut)
	})

	test('queued prompt uses same fragment kind as normal prompt', () => {
		// queued uses 'prompt' kind (not 'prompt.steering'), just adds prefix text
		resetFormat('s9')
		const normalEvent = {
			id: '6', type: 'prompt' as const, sessionId: 's9',
			text: 'test', source: localSource, createdAt: '',
		}
		const normalOut = pushEvent(normalEvent, localSource)

		resetFormat('s10')
		const queuedEvent = {
			id: '7', type: 'prompt' as const, sessionId: 's10',
			text: 'test', label: 'queued' as const, source: localSource, createdAt: '',
		}
		const queuedOut = pushEvent(queuedEvent, localSource)

		// Both should use the same styling — only difference is prefix text
		expect(stripAnsi(queuedOut)).toContain('[queued] test')
		expect(stripAnsi(normalOut)).not.toContain('[queued]')
	})

	test('remote prompt ignores label and uses source prefix instead', () => {
		resetFormat('s11')
		const remoteSource = { kind: 'web' as const, clientId: 'remote-123456' }
		const event = {
			id: '8', type: 'prompt' as const, sessionId: 's11',
			text: 'remote msg', label: 'queued' as const, source: remoteSource, createdAt: '',
		}
		const out = pushEvent(event, localSource)
		// Remote prompts get the [prompt:web:remote] prefix, not [queued]
		expect(stripAnsi(out)).toContain('[prompt:web:remote]')
		expect(stripAnsi(out)).toContain('remote msg')
	})
})