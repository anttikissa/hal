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
	expect(view.submit(busy, 'more')).toEqual({ command: { type: 'submit', sessionId, text: 'more' }, keep: false })
	expect(view.submit(busy, 'later', true)).toEqual({ command: { type: 'submit', sessionId, text: 'later', queue: true }, keep: false })
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

test('waiting messages are shown with why they wait', () => {
	let st = fold([
		{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'paused' }, inbox: [{ id: 'a', text: 'next', queue: true }] } },
	])
	expect(view.inbox(st)).toEqual([{ text: 'next', label: expect.stringMatching(/paused/) }])
	expect(view.inbox(view.onEvent(st, { type: 'inbox', sessionId, inbox: [] }))).toEqual([])
	expect(view.inbox({})).toEqual([])
})

test('the open question is filled in with browser keys and answered; afterwards it shows the answer', () => {
	let form = { text: 'Create it?', fields: [{ type: 'choice' as const, name: 'ok', options: ['yes', 'no'], initial: 1 }] }
	let st = fold([
		{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'blocked', reason: 'question' } } },
		{ type: 'question', sessionId, id: 'q1', form },
	])
	expect(st.form?.id).toBe('q1')
	let browser = (key: string, mods = {}) => view.key({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods })
	expect(browser('Shift')).toBeUndefined()
	let left = view.formKey(st, browser('ArrowLeft')!)
	expect(left.command).toBeUndefined()
	let enter = view.formKey(left.state, browser('Enter')!)
	expect(enter.command).toEqual({ type: 'answer', sessionId, question: 'q1', answers: { ok: 'yes' } })
	expect(view.formKey(st, browser('Escape')!).command).toEqual({ type: 'pause', sessionId })
	st = fold([{ type: 'answer', sessionId, question: 'q1', answers: { ok: 'yes' } }], enter.state)
	expect(st.form).toBeUndefined()
	expect(shown(st)).toEqual([{ kind: 'question warning', text: '? Create it?\n  yes' }])
})

test('Up on an empty input while the model works edits the last prompt; Enter sends it, Down or Escape continues', () => {
	let running = fold([
		{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'running', phase: 'streaming' } } },
		{ type: 'turn-start', sessionId, prompt: 'fix ti', provider: 'fake' },
	])
	expect(view.editKey(running, 'up', 'draft')).toBeUndefined()
	let up = view.editKey(running, 'up', '')!
	expect(up).toMatchObject({ command: { type: 'pause', sessionId }, text: 'fix ti' })
	let editing = fold([{ type: 'state', sessionId, state: { type: 'paused' } }], up.view)
	expect(view.notice(editing)).toMatch(/editing/)
	expect(view.submit(editing, 'fix it')).toEqual({ command: { type: 'submit', sessionId, text: 'fix it', amend: true }, keep: false })
	expect(view.editKey(editing, 'down', 'fix it')).toBeUndefined()
	let down = view.editKey(editing, 'down', 'fix ti')!
	expect(down).toEqual({ view: { ...editing, editing: undefined }, command: { type: 'continue', sessionId }, text: '' })
	// Escape keeps changed text.
	expect(view.editKey(editing, 'escape', 'fix it')).toEqual({ view: { ...editing, editing: undefined }, command: { type: 'continue', sessionId }, text: 'fix it' })
})

test('a question shows its quote under the text', () => {
	let form = { text: 'Run this?', quote: { text: 'rm -rf x', marks: [[0, 8]] as [number, number][] }, fields: [{ type: 'choice' as const, name: 'run', options: ['yes', 'no'] }] }
	let st = fold([
		{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'blocked', reason: 'question' } } },
		{ type: 'question', sessionId, id: 'q1', form },
		{ type: 'answer', sessionId, question: 'q1', answers: { run: 'no' } },
	])
	expect(shown(st)).toEqual([{ kind: 'question warning', text: '? Run this?\n    rm -rf x\n  no' }])
})

test('commands show who sent them, and their output; a cancelled question says so', () => {
	let form = { text: 'Create?', fields: [{ type: 'choice' as const, name: 'create', options: ['yes', 'no'] }] }
	let st = fold([
		{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } },
		{ type: 'command', sessionId, text: '/help' },
		{ type: 'output', sessionId, text: 'Commands' },
		{ type: 'command', sessionId, text: '/cd x', from: '7-abc' },
		{ type: 'question', sessionId, id: 'q', form },
		{ type: 'answer', sessionId, question: 'q', answers: {}, cancelled: true },
		{ type: 'output', sessionId, text: 'nope', error: true },
	])
	let texts = shown(st).map((s) => s!.text)
	expect(texts[0]).toBe('/help')
	expect(texts[1]).toBe('Commands')
	expect(texts[2]).toContain('/cd x')
	expect(texts[2]).toContain('sent from 7-abc')
	expect(texts[3]).toContain('(cancelled)')
	expect(shown(st)[4]!.kind).toContain('error')
})

test('Tab asks the host to complete a command; its answer fills the box only if unchanged', () => {
	let st = fold([{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } }])
	expect(view.complete(st, 'hello')).toBeUndefined()
	expect(view.complete(st, '/cd ~/p')).toEqual({ type: 'complete', sessionId, text: '/cd ~/p' })
	let event = { type: 'completions' as const, sessionId, text: '/cd ~/p', items: ['/cd ~/projects/'] }
	expect(view.completed(st, event, '/cd ~/p')).toEqual({ text: '/cd ~/projects/' })
	expect(view.completed(st, event, '/cd ~/px')).toBeUndefined()
	expect(view.completed(st, { ...event, items: [] }, '/cd ~/p')).toEqual({ text: '/cd ~/p', notice: 'no completions' })
})

test('Ctrl-M opens the model picker from the host list; typing filters, Enter switches, Escape closes', () => {
	let st = fold([{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } }])
	expect(view.modelsKey(st, view.key({ key: 'm', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })!)).toEqual({ type: 'models', sessionId })
	expect(view.modelsKey(st, view.key({ key: 'm', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })!)).toBeUndefined()
	let items = ['fake/m', 'x/step-3.5-flash', 'anthropic/claude-opus-5-5']
	st = view.onEvent(st, { type: 'models', sessionId, current: 'fake/m', items })
	expect(st.modal?.items).toEqual(items)
	st = view.search(st, 'opus-5.5')
	expect(st.modal?.items).toEqual(['anthropic/claude-opus-5-5'])
	let r = view.modalKey(st, { key: 'enter' })
	expect(r.command).toEqual({ type: 'submit', sessionId, text: '/model anthropic/claude-opus-5-5' })
	expect(r.state.modal).toBeUndefined()
	st = view.onEvent(r.state, { type: 'models', sessionId, current: 'fake/m', items })
	r = view.modalKey(view.modalKey(st, { key: 'down' }).state, { key: 'escape' })
	expect(r.command).toBeUndefined()
	expect(r.state.modal).toBeUndefined()
	expect(r.state.transcript).toBe(st.transcript)
	// Another session's list opens nothing.
	expect(view.onEvent(r.state, { type: 'models', sessionId: 'x', current: 'a/b', items }).modal).toBeUndefined()
})

test('the transcript sticks to the bottom only when scrolled to (near) it', () => {
	expect(view.atBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true)
	expect(view.atBottom({ scrollHeight: 1000, scrollTop: 570, clientHeight: 400 })).toBe(true)
	expect(view.atBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 })).toBe(false)
	// Content shorter than the viewport.
	expect(view.atBottom({ scrollHeight: 200, scrollTop: 0, clientHeight: 400 })).toBe(true)
})
