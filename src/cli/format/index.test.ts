import { describe, test, expect } from 'bun:test'
import { pushFragment, pushEvent, createFormatState, stripAnsi, renderToolProgressLines } from './index.ts'

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

describe('tool progress', () => {
	const localSource = { kind: 'cli' as const, clientId: 'test-client' }
	const makeTool = (overrides: Partial<{
		name: string; inputSummary: string; status: 'running' | 'done'
		elapsed: number; bytes: number; totalLines: number; lastLines: string[]
	}> = {}) => ({
		name: 'bash', inputSummary: 'echo hi', status: 'running' as const,
		elapsed: 0, bytes: 0, totalLines: 0, lastLines: [] as string[],
		...overrides,
	})
	const makeEvent = (tools: ReturnType<typeof makeTool>[]) => ({
		id: '1', type: 'tool_progress' as const, sessionId: 's1',
		tools, createdAt: '',
	})

	test('renders 4 lines per tool (1 header + 3 content)', () => {
		const s = st()
		const event = makeEvent([
			makeTool({ name: 'grep', inputSummary: 'pattern src/', elapsed: 1200, bytes: 500, totalLines: 2, lastLines: ['line 1', 'line 2'] }),
			makeTool({ name: 'read', inputSummary: '/tmp/foo.ts', elapsed: 100 }),
		])
		const out = pushEvent(event, localSource, s)
		const plain = stripAnsi(out)
		// 2 tools × 4 lines = 8 lines
		expect(out.split('\n').length - 1).toBe(8)
		expect(s.toolProgressLines).toBe(8)
		expect(plain).toContain('<tool.grep>')
		expect(plain).toContain('<tool.read>')
		expect(plain).toContain('--- pattern src/ ---')
		expect(plain).toContain('1.2s')
		expect(plain).toContain('500 bytes')
		expect(plain).toContain('line 1')
		expect(plain).toContain('line 2')
	})

	test('header shows pending/done status labels', () => {
		const s = st()
		const event = makeEvent([
			makeTool({ status: 'running', elapsed: 500 }),
			makeTool({ name: 'read', inputSummary: 'foo.ts', status: 'done', elapsed: 100, bytes: 340 }),
		])
		const plain = stripAnsi(pushEvent(event, localSource, s))
		expect(plain).toContain('pending')
		expect(plain).toContain('done')
	})

	test('overflow shows [N more lines]', () => {
		const s = st()
		const event = makeEvent([
			makeTool({ totalLines: 10, lastLines: ['a', 'b', 'c'] }),
		])
		const plain = stripAnsi(pushEvent(event, localSource, s))
		expect(plain).toContain('[+ 8 more lines]')
	})

	test('subsequent events do not include cursor-up-erase (client handles mutation)', () => {
		const s = st()
		s.toolProgressLines = 8
		const event = makeEvent([
			makeTool({ status: 'done' }),
			makeTool({ status: 'running' }),
		])
		const out = pushEvent(event, localSource, s)
		// No cursor-up-erase sequences — client uses direct outputLines mutation
		expect(out).not.toMatch(/\x1b\[\d+A\x1b\[J/)
		expect(stripAnsi(out)).toContain('<tool.bash>')
		expect(s.toolProgressLines).toBe(8)
	})

	test('all done sets toolProgressLines to 0', () => {
		const s = st()
		s.toolProgressLines = 4
		const event = makeEvent([makeTool({ status: 'done' })])
		pushEvent(event, localSource, s)
		expect(s.toolProgressLines).toBe(0)
	})

	test('renderToolProgressLines returns flat string array for mutation', () => {
		const lines = renderToolProgressLines([
			makeTool({ name: 'bash', inputSummary: 'echo hi', status: 'done', totalLines: 5, lastLines: ['a', 'b', 'c'] }),
		], 80)
		// 1 header + 3 content = 4 lines
		expect(lines.length).toBe(4)
		expect(stripAnsi(lines[0])).toContain('<tool.bash>')
		expect(stripAnsi(lines[0])).toContain('echo hi')
		// No newlines within individual lines
		for (const line of lines) expect(line).not.toContain('\n')
	})
})