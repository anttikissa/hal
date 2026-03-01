import { describe, test, expect } from 'bun:test'
import { pushFragment, pushEvent, createFormatState, stripAnsi } from './index.ts'
import { loadActiveTheme } from './theme.ts'

const RESET = '\x1b[0m'
const st = () => createFormatState()

describe('cli format index', () => {
	test('chunk transition prefix uses RESET first and newline between channels', () => {
		const s = st()
		const first = pushFragment('chunk.assistant', 'hello', s)
		expect(first.startsWith(RESET)).toBe(true)

		const secondSameKind = pushFragment('chunk.assistant', 'world', s)
		expect(secondSameKind.startsWith('\n')).toBe(false)
		expect(secondSameKind.startsWith(RESET)).toBe(false)

		const thirdDifferentKind = pushFragment('chunk.thinking', 'hmm', s)
		expect(thirdDifferentKind.startsWith('\n')).toBe(true)
	})

	test('line styles are applied per line including multi-line content', () => {
		loadActiveTheme(process.cwd(), 'default')
		const out = pushFragment('line.warn', 'one\ntwo', st())
		expect(out).toContain('\x1b[33mone\x1b[0m\n\x1b[33mtwo\x1b[0m')
		expect(out.endsWith('\n')).toBe(true)
	})

	test('prefix styling keeps remainder styled after prefix reset', () => {
		loadActiveTheme(process.cwd(), 'default')
		const out = pushFragment('line.tool', '[tool] done', st())
		expect(out).toContain('\x1b[0m\x1b[36mdone')
	})
})

describe('consecutive block spacing', () => {
	test('one blank line between consecutive prompt blocks', () => {
		const s = st()
		const first = pushFragment('prompt', 'first message', s)
		const second = pushFragment('prompt', 'second message', s)
		expect(first + second).not.toMatch(/\n{3,}/)
	})

	test('no double blank between queued and steering prompt', () => {
		const s = st()
		pushFragment('prompt', '[queued] msg', s)
		const steering = pushFragment('prompt.steering', '[steering] msg', s)
		expect(steering).not.toMatch(/^\n/)
	})

	test('prompt after non-block line still has blank line separator', () => {
		const s = st()
		pushFragment('line.info', 'some info', s)
		const prompt = pushFragment('prompt', 'my message', s)
		expect(prompt).toMatch(/^\n/)
	})

	test('one blank line before steering even with events between', () => {
		const s = st()
		pushFragment('prompt', 'you can push changes', s)
		pushFragment('chunk.assistant', 'model output', s)
		pushFragment('line.warn', '[context] warning', s)
		const steering = pushFragment('prompt.steering', '[steering] steer', s)
		expect(steering).toMatch(/^\n/)
		expect(steering).not.toMatch(/^\n\n/)
	})

	test('blank line before first chunk after prompt', () => {
		const s = st()
		pushFragment('prompt', 'user question', s)
		const thinking = pushFragment('chunk.thinking', 'Let me think...', s)
		expect(thinking).toMatch(/^\n/)
	})

	test('blank line before assistant chunk after prompt', () => {
		const s = st()
		pushFragment('prompt', 'user question', s)
		const assistant = pushFragment('chunk.assistant', 'Sure!', s)
		expect(assistant).toMatch(/^\n/)
	})
})

describe('trailing-newline-aware spacing', () => {
	test('notice block + prompt block: exactly one blank line', () => {
		const s = st()
		pushFragment('chunk.assistant', 'some response\n', s)
		const notice = pushFragment('line.notice', '[context] >66% full', s)
		const prompt = pushFragment('prompt', 'user message', s)
		const combined = notice + prompt
		const plain = stripAnsi(combined)
		const lines = plain.split('\n')
		const noticeEnd = lines.findIndex(l => l.includes('>66%'))
		const promptStart = lines.findIndex((l, i) => i > noticeEnd && l.includes('user message'))
		expect(promptStart - noticeEnd).toBeLessThanOrEqual(4)
		expect(promptStart - noticeEnd).toBeGreaterThanOrEqual(3)
	})

	test('tool output with trailing newline: one blank line before next section', () => {
		const s = st()
		pushFragment('line.tool', '[bash] echo hi', s)
		const tool = pushFragment('line.tool', 'hi\n', s)
		const chunk = pushFragment('chunk.assistant', 'Done.', s)
		const combined = stripAnsi(tool + chunk)
		expect(combined).toMatch(/hi\n\n.*Done\./)
		expect(combined).not.toMatch(/hi\n\n\n/)
	})

	test('chunk ending with newline (block_stop): one blank line before block', () => {
		const s = st()
		pushFragment('chunk.assistant', 'text content', s)
		pushFragment('chunk.assistant', '\n', s)
		const notice = pushFragment('line.notice', '[context] warning', s)
		expect(notice).toMatch(/^\n[^\n]/)
	})

	test('tool output without trailing newline: still one blank line', () => {
		const s = st()
		pushFragment('line.tool', '[bash] echo hi', s)
		const tool = pushFragment('line.tool', 'hi', s)
		const chunk = pushFragment('chunk.assistant', 'Done.', s)
		const combined = stripAnsi(tool + chunk)
		expect(combined).toMatch(/hi\n\n.*Done\./)
		expect(combined).not.toMatch(/hi\n\n\n/)
	})

	test('assistant text in history replay: one blank line after prompt', () => {
		const s = st()
		const prompt = pushFragment('prompt', 'question', s)
		const reply = pushFragment('assistant', 'answer text', s)
		const combined = prompt + reply
		const plain = stripAnsi(combined)
		const lines = plain.split('\n')
		const promptEnd = lines.findLastIndex(l => l.includes('question'))
		const answerStart = lines.findIndex((l, i) => i > promptEnd && l.includes('answer'))
		expect(answerStart - promptEnd).toBe(3)
	})

	test('interleaved local + session events share state on screen', () => {
		// KEY test: local events update the same state as session events
		const screen = st()
		pushFragment('chunk.assistant', '🤘', screen)
		pushFragment('chunk.assistant', '\n', screen)
		// Local event goes through same screen state
		pushFragment('local.info', '[perf] startup: 98ms', screen)
		const prompt = pushFragment('prompt', 'Nice', screen)
		// local.info ended with trailingNL=1, so prompt sep should be just \n (not \n\n)
		expect(prompt).toMatch(/^\n[^\n]/)   // starts with exactly one \n
	})
})

describe('in-place redraw for steering', () => {
	test('steering after queued prompt includes cursor-up escape', () => {
		const s = st()
		pushFragment('prompt', '[queued] hello', s)
		const steering = pushFragment('prompt.steering', '[steering] hello', s)
		expect(steering).toMatch(/\x1b\[\d+A/)
		expect(steering).toContain('\x1b[J')
	})

	test('steering after queued restores leading blank line', () => {
		const s = st()
		pushFragment('prompt', '[queued] msg', s)
		const steering = pushFragment('prompt.steering', '[steering] msg', s)
		const afterClear = steering.split('\x1b[J')[1] ?? ''
		expect(afterClear).toMatch(/^\n/)
	})

	test('no cursor-up when model output is between queued and steering', () => {
		const s = st()
		pushFragment('prompt', '[queued] msg', s)
		pushFragment('chunk.assistant', 'model says stuff', s)
		const steering = pushFragment('prompt.steering', '[steering] msg', s)
		expect(steering).not.toMatch(/\x1b\[\d+A/)
	})

	test('no cursor-up for non-steering prompt after prompt', () => {
		const s = st()
		pushFragment('prompt', 'first', s)
		const second = pushFragment('prompt', 'second', s)
		expect(second).not.toMatch(/\x1b\[\d+A/)
	})
})

describe('chunk to prompt truncation marker', () => {
	test('shows -- marker when chunk transitions to prompt', () => {
		const s = st()
		pushFragment('chunk.assistant', 'A daemon w', s)
		const out = pushFragment('prompt', 'in spanish', s)
		expect(stripAnsi(out)).toContain(' --')
	})

	test('shows -- marker when chunk transitions to steering prompt', () => {
		const s = st()
		pushFragment('chunk.assistant', 'The bits', s)
		const out = pushFragment('prompt.steering', '[steering] in spanish', s)
		expect(stripAnsi(out)).toContain(' --')
	})

	test('no -- marker when line transitions to prompt', () => {
		const s = st()
		pushFragment('line.info', 'some info', s)
		const out = pushFragment('prompt', 'hello', s)
		expect(stripAnsi(out)).not.toContain(' --')
	})

	test('no -- marker when chunk transitions to non-prompt', () => {
		const s = st()
		pushFragment('chunk.assistant', 'some output', s)
		const out = pushFragment('line.info', 'info line', s)
		expect(stripAnsi(out)).not.toContain(' --')
	})

	test('-- marker is styled in orange (warn color)', () => {
		loadActiveTheme(process.cwd(), 'default')
		const s = st()
		pushFragment('chunk.assistant', 'text', s)
		const out = pushFragment('prompt', 'msg', s)
		expect(out).toContain('\x1b[33m--')
	})
})

describe('prompt label rendering', () => {
	const localSource = { kind: 'cli' as const, clientId: 'test-client' }

	test('normal prompt has no prefix', () => {
		const event = {
			id: '1', type: 'prompt' as const, sessionId: 's4',
			text: 'hello world', source: localSource, createdAt: '',
		}
		const out = pushEvent(event, localSource, st())
		expect(stripAnsi(out)).toContain('hello world')
		expect(stripAnsi(out)).not.toContain('[queued]')
		expect(stripAnsi(out)).not.toContain('[steering]')
	})

	test('queued prompt has [queued] prefix', () => {
		const event = {
			id: '2', type: 'prompt' as const, sessionId: 's5',
			text: 'queued msg', label: 'queued' as const, source: localSource, createdAt: '',
		}
		const out = pushEvent(event, localSource, st())
		expect(stripAnsi(out)).toContain('[queued] queued msg')
	})

	test('steering prompt has [steering] prefix', () => {
		const event = {
			id: '3', type: 'prompt' as const, sessionId: 's6',
			text: 'steer msg', label: 'steering' as const, source: localSource, createdAt: '',
		}
		const out = pushEvent(event, localSource, st())
		expect(stripAnsi(out)).toContain('[steering] steer msg')
	})

	test('steering prompt uses different fragment kind than normal/queued', () => {
		const normalEvent = {
			id: '4', type: 'prompt' as const, sessionId: 's7',
			text: 'same text', source: localSource, createdAt: '',
		}
		const normalOut = pushEvent(normalEvent, localSource, st())

		const steeringEvent = {
			id: '5', type: 'prompt' as const, sessionId: 's8',
			text: 'same text', label: 'steering' as const, source: localSource, createdAt: '',
		}
		const steeringOut = pushEvent(steeringEvent, localSource, st())

		expect(stripAnsi(normalOut)).toContain('same text')
		expect(stripAnsi(steeringOut)).toContain('[steering] same text')
		expect(steeringOut).not.toBe(normalOut)
	})

	test('queued prompt uses same fragment kind as normal prompt', () => {
		const normalEvent = {
			id: '6', type: 'prompt' as const, sessionId: 's9',
			text: 'test', source: localSource, createdAt: '',
		}
		const normalOut = pushEvent(normalEvent, localSource, st())

		const queuedEvent = {
			id: '7', type: 'prompt' as const, sessionId: 's10',
			text: 'test', label: 'queued' as const, source: localSource, createdAt: '',
		}
		const queuedOut = pushEvent(queuedEvent, localSource, st())

		expect(stripAnsi(queuedOut)).toContain('[queued] test')
		expect(stripAnsi(normalOut)).not.toContain('[queued]')
	})

	test('remote prompt ignores label and uses source prefix instead', () => {
		const remoteSource = { kind: 'web' as const, clientId: 'remote-123456' }
		const event = {
			id: '8', type: 'prompt' as const, sessionId: 's11',
			text: 'remote msg', label: 'queued' as const, source: remoteSource, createdAt: '',
		}
		const out = pushEvent(event, localSource, st())
		expect(stripAnsi(out)).toContain('[prompt:web:remote]')
		expect(stripAnsi(out)).toContain('remote msg')
	})
})
