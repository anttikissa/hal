import { describe, test, expect } from 'bun:test'
import { pushFragment, pushEvent, createFormatState, stripAnsi } from './index.ts'
import { loadActiveTheme } from './theme.ts'

const st = () => createFormatState()

describe('fragment tags', () => {
	test('first fragment gets <kind> tag, no leading newline', () => {
		const out = pushFragment('chunk.assistant', 'hello', st())
		expect(stripAnsi(out)).toMatch(/^<assistant> hello/)
	})

	test('same chunk kind gets <more> tag', () => {
		const s = st()
		pushFragment('chunk.assistant', 'hello', s)
		const out = pushFragment('chunk.assistant', ' world', s)
		expect(stripAnsi(out)).toMatch(/^<more>  world/)
	})

	test('different chunk kind gets newline + <kind> tag', () => {
		const s = st()
		pushFragment('chunk.thinking', 'hmm', s)
		const out = pushFragment('chunk.assistant', 'Sure!', s)
		expect(stripAnsi(out)).toMatch(/^\n<assistant> Sure!/)
	})

	test('non-chunk after chunk gets newline + <kind> tag', () => {
		const s = st()
		pushFragment('chunk.assistant', 'text', s)
		const out = pushFragment('line.info', 'info here', s)
		expect(stripAnsi(out)).toMatch(/^\n<info> /)
	})

	test('prompt gets <prompt> tag', () => {
		const out = pushFragment('prompt', 'user question', st())
		expect(stripAnsi(out)).toMatch(/^<prompt> /)
	})

	test('line kinds use suffix as label', () => {
		const s = st()
		const out = pushFragment('line.tool', '[bash] echo hi', s)
		expect(stripAnsi(out)).toMatch(/^<tool> /)
	})
})

describe('styling', () => {
	test('line styles are applied per line including multi-line content', () => {
		loadActiveTheme(process.cwd(), 'default')
		const out = pushFragment('line.warn', 'one\ntwo', st())
		expect(out).toContain('\x1b[33mone\x1b[0m\n\x1b[33mtwo\x1b[0m')
	})

	test('prefix styling keeps remainder styled after prefix reset', () => {
		loadActiveTheme(process.cwd(), 'default')
		const out = pushFragment('line.tool', '[tool] done', st())
		expect(out).toContain('\x1b[0m\x1b[36mdone')
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
		const normalOut = pushEvent({
			id: '4', type: 'prompt' as const, sessionId: 's7',
			text: 'same text', source: localSource, createdAt: '',
		}, localSource, st())

		const steeringOut = pushEvent({
			id: '5', type: 'prompt' as const, sessionId: 's8',
			text: 'same text', label: 'steering' as const, source: localSource, createdAt: '',
		}, localSource, st())

		expect(stripAnsi(normalOut)).toContain('same text')
		expect(stripAnsi(steeringOut)).toContain('[steering] same text')
		expect(steeringOut).not.toBe(normalOut)
	})

	test('remote prompt uses source prefix', () => {
		const remoteSource = { kind: 'web' as const, clientId: 'remote-123456' }
		const out = pushEvent({
			id: '8', type: 'prompt' as const, sessionId: 's11',
			text: 'remote msg', label: 'queued' as const, source: remoteSource, createdAt: '',
		}, localSource, st())
		expect(stripAnsi(out)).toContain('[prompt:web:remote]')
		expect(stripAnsi(out)).toContain('remote msg')
	})
})
