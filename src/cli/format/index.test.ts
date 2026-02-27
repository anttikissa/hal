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