import { expect, test } from 'bun:test'
import type { Event } from '../common/protocol.ts'
import { view, type ViewState } from './view.ts'

const meta = { id: '1-abc', cwd: '/w', model: 'fake/m', createdAt: '2026-09-26T00:00:00Z' }
const sessionId = meta.id
const ts = '2026-09-26T00:00:01Z'

const fold = (events: Event[], st: ViewState = {}) => events.reduce(view.onEvent, st)
const shown = (st: ViewState) => st.transcript!.items.map(view.show).filter(Boolean)

test('events fold into what the page shows, like the terminal transcript', () => {
	let st = fold([
		{ type: 'snapshot', sessionId, snapshot: { meta, history: [{ type: 'user', blocks: [{ type: 'text', text: 'old' }], ts }] } },
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake' },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'hm' } },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'he' } },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'llo' } },
		{ type: 'stream', sessionId, event: { type: 'tool_call', id: 't', name: 'bash', input: { command: 'ls -l', description: 'List files' } } },
		{ type: 'tool-results', sessionId, results: [{ type: 'tool_result', id: 't', output: 'a\nb\n' }] },
		{ type: 'turn-end', sessionId, status: 'cancelled' },
		{ type: 'turn-start', sessionId, prompt: 'again', provider: 'fake' },
		{ type: 'turn-end', sessionId, status: 'error', error: 'boom' },
		{ type: 'turn-start', sessionId, prompt: 'ok', provider: 'fake' },
		{ type: 'turn-end', sessionId, status: 'completed' },
	] as Event[])
	expect(shown(st)).toEqual([
		{ kind: 'prompt', text: 'old' },
		{ kind: 'prompt', text: 'go' },
		{ kind: 'thinking', text: 'hm' },
		{ kind: 'text', text: 'hello' },
		{ kind: 'tool', text: '▸ List files\n  $ ls -l' },
		{ kind: 'result', text: '◂ a\n  b' },
		{ kind: 'end', text: '[cancelled]' },
		{ kind: 'prompt', text: 'again' },
		{ kind: 'end error', text: 'error: boom' },
		{ kind: 'prompt', text: 'ok' },
	])
})

test('long and failed tool results show a marked glimpse', () => {
	let output = Array.from({ length: view.resultRows() + 3 }, (_, i) => `l${i}`).join('\n')
	let s = view.show({ type: 'tool-result', id: 't', output, isError: true })!
	expect(s.kind).toContain('error')
	expect(s.text.startsWith('✗ l0\n')).toBe(true)
	expect(s.text.split('\n')).toHaveLength(view.resultRows() + 1)
	expect(s.text.endsWith('… 3 more lines')).toBe(true)
})

test('a rejected command becomes a notice and keeps the transcript', () => {
	let st = fold([{ type: 'snapshot', sessionId, snapshot: { meta, history: [] } }])
	let after = view.onEvent(st, { type: 'rejected', sessionId, command: 'submit', reason: 'busy' })
	expect(after.notice).toBe('submit refused: busy')
	expect(after.transcript).toBe(st.transcript)
})

test('submit and cancel follow whether a turn is running', () => {
	expect(view.submit({}, 'hi')).toEqual({ notice: 'no session yet', keep: true })
	let idle = fold([{ type: 'snapshot', sessionId, snapshot: { meta, history: [] } }])
	expect(view.submit(idle, '  \n')).toEqual({ keep: false })
	expect(view.submit(idle, 'hi')).toEqual({ command: { type: 'submit', sessionId, text: 'hi' }, keep: false })
	expect(view.cancel(idle)).toBeUndefined()
	let busy = view.onEvent(idle, { type: 'turn-start', sessionId, prompt: 'hi', provider: 'fake' })
	expect(view.submit(busy, 'more').keep).toBe(true)
	expect(view.submit(busy, 'more').command).toBeUndefined()
	expect(view.cancel(busy)).toEqual({ type: 'cancel', sessionId })
})
