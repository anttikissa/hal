import { describe, test, expect } from 'bun:test'
import { pushFragment, pushEvent, createFormatState, stripAnsi } from './index.ts'

const st = () => createFormatState()

describe('fragment tags', () => {
	test('first fragment gets <kind> tag, no leading newline', () => {
		const out = pushFragment('chunk.assistant', 'hello', st())
		expect(stripAnsi(out)).toBe('<assistant> hello')
	})

	test('same chunk kind produces no tag', () => {
		const s = st()
		pushFragment('chunk.assistant', 'hello', s)
		const out = pushFragment('chunk.assistant', ' world', s)
		expect(stripAnsi(out)).toBe(' world')
	})

	test('different chunk kind gets newline + <kind> tag', () => {
		const s = st()
		pushFragment('chunk.thinking', 'hmm', s)
		const out = pushFragment('chunk.assistant', 'Sure!', s)
		expect(stripAnsi(out)).toBe('\n<assistant> Sure!')
	})

	test('non-chunk after chunk gets newline + <kind> tag', () => {
		const s = st()
		pushFragment('chunk.assistant', 'text', s)
		const out = pushFragment('line.info', 'info here', s)
		expect(stripAnsi(out)).toBe('\n<info> info here\n')
	})

	test('prompt gets <prompt> tag', () => {
		const out = pushFragment('prompt', 'user question', st())
		expect(stripAnsi(out)).toBe('<prompt> user question\n')
	})

	test('line kinds use suffix as label', () => {
		const out = pushFragment('line.tool', '[bash] echo hi', st())
		expect(stripAnsi(out)).toBe('<tool> [bash] echo hi\n')
	})

	test('non-chunk after non-chunk: no extra newline', () => {
		const s = st()
		pushFragment('line.tool', '[grep] stuff', s)
		const out = pushFragment('line.tool', '5 matches', s)
		expect(stripAnsi(out)).toBe('<tool> 5 matches\n')
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

	test('steering prompt has [steering] prefix', () => {
		const event = {
			id: '3', type: 'prompt' as const, sessionId: 's6',
			text: 'steer msg', label: 'steering' as const, source: localSource, createdAt: '',
		}
		const out = pushEvent(event, localSource, st())
		expect(stripAnsi(out)).toContain('[steering] steer msg')
	})

	test('remote prompt uses source prefix', () => {
		const remoteSource = { kind: 'web' as const, clientId: 'remote-123456' }
		const out = pushEvent({
			id: '8', type: 'prompt' as const, sessionId: 's11',
			text: 'remote msg', source: remoteSource, createdAt: '',
		}, localSource, st())
		expect(stripAnsi(out)).toContain('[prompt:web:remote]')
		expect(stripAnsi(out)).toContain('remote msg')
	})
})
