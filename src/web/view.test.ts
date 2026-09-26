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
		{ type: 'snapshot', sessionId, snapshot: { meta, history: [{ type: 'user', blocks: [{ type: 'text', text: 'old' }], ts }], state: { type: 'idle' } } },
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake' },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'hm' } },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'he' } },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'llo' } },
		{ type: 'stream', sessionId, event: { type: 'tool_call', id: 't', name: 'bash', input: { command: 'ls -l', description: 'List files' } } },
		{ type: 'tool-results', sessionId, results: [{ type: 'tool_result', id: 't', output: 'a\nb\n' }] },
		{ type: 'turn-end', sessionId, status: 'paused' },
		{ type: 'turn-start', sessionId, prompt: 'again', provider: 'fake' },
		{ type: 'turn-end', sessionId, status: 'error', error: 'boom' },
		{ type: 'turn-start', sessionId, prompt: 'ok', provider: 'fake' },
		{ type: 'turn-end', sessionId, status: 'completed' },
	] as Event[])
	expect(shown(st)).toEqual([
		{ kind: 'user', text: 'old' },
		{ kind: 'user', text: 'go' },
		{ kind: 'thinking', text: 'hm' },
		{ kind: 'assistant', text: 'hello' },
		{ kind: 'tool tool-bash', text: '▸ List files\n  $ ls -l' },
		{ kind: 'result log', text: '◂ a\n  b' },
		{ kind: 'end log', text: '[paused]' },
		{ kind: 'user', text: 'again' },
		{ kind: 'end error', text: 'error: boom' },
		{ kind: 'user', text: 'ok' },
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
	let st = fold([{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } }])
	let after = view.onEvent(st, { type: 'rejected', sessionId, command: 'submit', reason: 'busy' })
	expect(after.notice).toBe('submit refused: busy')
	expect(after.transcript).toBe(st.transcript)
})

test('a config warning becomes a notice and keeps the transcript', () => {
	let st = fold([{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } }])
	let after = view.onEvent(st, { type: 'warning', text: 'config.ason: webPort: bad' })
	expect(after.notice).toContain('webPort')
	expect(after.transcript).toBe(st.transcript)
})

test('Enter and Escape follow the session state', () => {
	expect(view.submit({}, 'hi')).toEqual({ notice: 'no session yet', keep: true })
	let idle = fold([{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } }])
	expect(view.submit(idle, '  \n')).toEqual({ keep: false })
	expect(view.submit(idle, 'hi')).toEqual({ command: { type: 'submit', sessionId, text: 'hi' }, keep: false })
	expect(view.pause(idle)).toBeUndefined()
	let busy = view.onEvent(idle, { type: 'state', sessionId, state: { type: 'running', phase: 'streaming' } })
	expect(view.submit(busy, 'more').keep).toBe(true)
	expect(view.submit(busy, 'more').command).toBeUndefined()
	expect(view.pause(busy)).toEqual({ type: 'pause', sessionId })
	let paused = view.onEvent(idle, { type: 'state', sessionId, state: { type: 'paused' } })
	expect(view.status(paused)).toMatch(/paused/)
	expect(view.submit(paused, '')).toEqual({ command: { type: 'continue', sessionId }, keep: false })
})

test('a tool gets a class for its name that no name can break out of', () => {
	let kind = view.show({ type: 'tool', id: 't', name: 'My Tool"><x', input: {} })!.kind
	expect(kind.split(' ')[0]).toBe('tool')
	expect(kind.split(' ')[1]).toMatch(/^tool-[a-z0-9-]+$/)
})

test('a snapshot with history marks where it ends; later events keep the mark', () => {
	let old = { type: 'snapshot', sessionId, snapshot: { meta, history: [{ type: 'user', blocks: [{ type: 'text', text: 'old' }], ts }], state: { type: 'idle' } } } as Event
	let st = fold([old, { type: 'turn-start', sessionId, prompt: 'new', provider: 'fake' }])
	expect(st.resumed).toEqual({ at: 1, last: ts })
	expect(st.transcript!.items.slice(st.resumed!.at)).toEqual([{ type: 'prompt', text: 'new' }])
	let empty = fold([{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } }], st)
	expect(empty.resumed).toBeUndefined()
})
