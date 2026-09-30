import { titles } from '../common/titles.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Event } from '../common/protocol.ts'
import { view, type ViewState } from './view.ts'

let originalNames: Record<string, string>
beforeEach(() => { originalNames = titles.names; titles.names = {} })
afterEach(() => { titles.names = originalNames })

const meta = { id: '1-abc', cwd: '/w', model: 'fake/m', createdAt: '2026-09-26T00:00:00Z' }
const sessionId = meta.id
const ts = '2026-09-26T00:00:01Z'

const fold = (events: Event[], st: ViewState = {}) => events.reduce(view.onEvent, st)
const shown = (st: ViewState) => st.transcript!.items.map((i) => view.show(i)).filter(Boolean)

test('status shows all session facts and percentages from pushed Stats, including refreshed turn-end data', () => {
	let st = fold([{ type: 'snapshot', sessionId, snapshot: {
		meta: { ...meta, name: 'Work', cwd: '/w/project', model: 'anthropic/claude-opus-5-5' }, history: [], state: { type: 'idle' },
		stats: { context: 87000, window: 1000000, sent: 252, received: 41000, plan: { account: 2, accounts: 3, windows: { '5h': 18, '7d': 92 } } },
	} }])
	expect(view.status(st)[2]?.parts[0]?.text).toBe('anthropic/claude-opus-5-5 (default/unknown)')
	st = view.onEvent(st, { type: 'model-names', names: { 'anthropic/claude-opus-5-5': 'Opus 5.5' } })
	let groups = view.status(st)
	expect(groups.map((g) => g.parts.map((p) => p.text).join(''))).toEqual([
		'1-abc: Work', '/w/project', 'Opus 5.5 (default/unknown)', '87k/1000k (9%)', '↑252 ↓41k', 'Sub 2/3: 5h 18%, 7d 92%',
	])
	expect(groups.flatMap((g) => g.parts).filter((p) => p.heat)).toEqual([
		{ text: '9%', heat: 'cool' }, { text: '18%', heat: 'cool' }, { text: '92%', heat: 'hot' },
	])
	st = view.onEvent(st, { type: 'turn-end', sessionId, status: 'completed', stats: { context: 810000, window: 1000000, sent: 1000, received: 10 } })
	expect(view.status(st).flatMap((g) => g.parts).find((p) => p.text === '81%')).toEqual({ text: '81%', heat: 'warm' })
	expect(view.status(st).map((g) => g.parts.map((p) => p.text).join(''))).toContain('↑1.0k ↓10')
})

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
		{ kind: 'user prompt', text: 'old' },
		{ kind: 'user prompt', text: 'go' },
		{ kind: 'thinking', text: 'hm' },
		{ kind: 'assistant', text: 'hello' },
		{ kind: 'tool tool-bash', text: '▸ List files\n  $ ls -l' },
		{ kind: 'result log', text: '◂ a\n  b' },
		{ kind: 'end log', text: '[paused]' },
		{ kind: 'user prompt', text: 'again' },
		{ kind: 'end error', text: 'error: boom' },
		{ kind: 'user prompt', text: 'ok' },
	])
})

test('long and failed tool results show a marked glimpse, and all of it in full', () => {
	let output = Array.from({ length: view.resultRows() + 3 }, (_, i) => `l${i}`).join('\n')
	let s = view.show({ type: 'tool-result', id: 't', output, isError: true })!
	expect(s.kind).toContain('error')
	expect(s.text.startsWith('✗ l0\n')).toBe(true)
	expect(s.text.split('\n')).toHaveLength(view.resultRows() + 1)
	expect(s.text.endsWith('… 3 more lines')).toBe(true)
	expect(view.show({ type: 'tool-result', id: 't', output }, true)!.text).toContain(`l${view.resultRows() + 2}`)
})

test('a rejected command or a config warning becomes a notice and keeps the transcript', () => {
	let st = fold([{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } }])
	let after = view.onEvent(st, { type: 'rejected', sessionId, command: 'submit', reason: 'busy' })
	expect(after.notice).toBe('submit refused: busy')
	expect(after.transcript).toBe(st.transcript)
	after = view.onEvent(st, { type: 'warning', text: 'config.ason: webPort: bad' })
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
	expect(view.submit(paused, '')).toEqual({ command: { type: 'continue', sessionId }, keep: false })
})

test('a tool gets a class for its name that no name can break out of', () => {
	let kind = view.show({ type: 'tool', id: 't', name: 'My Tool"><x', input: {} })!.kind
	expect(kind.split(' ')[0]).toBe('tool')
	expect(kind.split(' ')[1]).toMatch(/^tool-[a-z0-9-]+$/)
})

test('the open question is filled in with browser keys and answered; afterwards it shows its quote and the answer', () => {
	let form = { text: 'Create it?', quote: { text: 'rm -rf x', marks: [[0, 8]] as [number, number][] }, fields: [{ type: 'choice' as const, name: 'ok', options: ['yes', 'no'], initial: 1 }] }
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
	expect(shown(st)).toEqual([{ kind: 'question warning', text: '? Create it?\n    rm -rf x\n  yes' }])
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
	expect(texts[2]).toBe('/cd x')
	// A command is drawn as the prompt it was typed as, its sender in the head.
	expect(shown(st)[2]!.kind).toBe(shown(st)[0]!.kind)
	expect(titles.who(st.transcript!.items[2]!)).toBe('Message from 7-abc')
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
	expect(view.commandKey(st, view.key({ key: 'm', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })!, false)).toEqual({ type: 'models', sessionId })
	expect(view.commandKey(st, view.key({ key: 'm', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })!, false)).toBeUndefined()
	let items = ['fake/m', 'x/step-3.5-flash', 'anthropic/claude-opus-5-5']
	st = view.onEvent(st, { type: 'models', sessionId, current: 'fake/m', items })
	expect(st.modal?.tree?.rows[st.modal.selected]?.id).toBe('fake/m')
	st = view.search(st, 'opus-5.5')
	expect(st.modal?.tree?.rows[st.modal.selected]?.id).toBe('anthropic/claude-opus-5-5')
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

const running = (items: Event[], state: object) =>
	fold([
		{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } },
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake' },
		...items, { type: 'state', sessionId, state } as Event] as Event[])

test('the status line says what the session is doing, like the terminal', () => {
	let line = (st: ViewState, connected = true) => view.line(st, connected)
	let idle = running([], { type: 'idle' })
	expect(line(idle)).toEqual({ text: 'idle', tone: 'idle' })
	let asking = running([], { type: 'running', phase: 'requesting' })
	expect(line(asking)).toEqual({ text: 'processing', tone: 'busy' })
	let thinking = running([{ type: 'stream', sessionId, event: { type: 'thinking', text: 'hm' } }] as Event[], { type: 'running', phase: 'streaming' })
	expect(line(thinking)).toEqual({ text: 'thinking', tone: 'busy' })
	expect(view.streaming(thinking)).toBe('thinking')
	let writing = running(
		[
			{ type: 'stream', sessionId, event: { type: 'thinking', text: 'hm' } },
			{ type: 'stream', sessionId, event: { type: 'text', text: 'hi' } },
		] as Event[],
		{ type: 'running', phase: 'streaming' },
	)
	expect(line(writing)).toEqual({ text: 'writing', tone: 'busy' })
	expect(view.streaming(writing)).toBe('text')
	// The tools still waiting for their results, by name.
	let calls = [
		{ type: 'stream', sessionId, event: { type: 'tool_call', id: 'a', name: 'bash', input: {} } },
		{ type: 'stream', sessionId, event: { type: 'tool_call', id: 'b', name: 'read', input: {} } },
	] as Event[]
	expect(line(running(calls, { type: 'running', phase: 'tools' }))).toEqual({ text: 'running bash, read', tone: 'busy' })
	// Nothing streams into a tool call or while idle: the cursor has a
	// line of its own.
	expect(view.streaming(running(calls, { type: 'running', phase: 'streaming' }))).toBeUndefined()
	expect(view.streaming(running([{ type: 'stream', sessionId, event: { type: 'text', text: 'hi' } }] as Event[], { type: 'idle' }))).toBeUndefined()
	let one = running([...calls, { type: 'tool-results', sessionId, results: [{ type: 'tool_result', id: 'a', output: '' }] }] as Event[], { type: 'running', phase: 'tools' })
	expect(line(one)).toEqual({ text: 'running read', tone: 'busy' })
	let paused = running([], { type: 'paused' })
	expect(line(paused).text).toMatch(/^paused/)
	expect(line(paused).tone).toBe('warn')
	expect(line(running([], { type: 'error', message: 'boom' })).tone).toBe('error')
	// An open question speaks for itself; a login says what to do.
	expect(line(running([], { type: 'blocked', reason: 'question' })).text).toBe('')
	expect(line(running([], { type: 'blocked', reason: 'log in: expired' })).text).toBe('log in: expired')
	// Losing the host outranks whatever the session last said.
	expect(line(writing, false)).toEqual({ text: 'reconnecting', tone: 'error' })
})

test('rows pair each tool call with its result and drop completed turn ends', () => {
	let st = running(
		[
			{ type: 'stream', sessionId, event: { type: 'tool_call', id: 'a', name: 'bash', input: {} } },
			{ type: 'stream', sessionId, event: { type: 'tool_call', id: 'b', name: 'read', input: {} } },
			{ type: 'tool-results', sessionId, results: [{ type: 'tool_result', id: 'b', output: 'B' }, { type: 'tool_result', id: 'a', output: 'A' }] },
			{ type: 'stream', sessionId, event: { type: 'text', text: 'done' } },
			{ type: 'turn-end', sessionId, status: 'completed' },
		] as Event[],
		{ type: 'idle' },
	)
	let rows = view.rows(st.transcript!.items)
	expect(rows.map((r) => [r.item.type, r.result?.type === 'tool-result' ? r.result.output : undefined])).toEqual([
		['prompt', undefined],
		['tool', 'A'],
		['tool', 'B'],
		['text', undefined],
	])
})

test('rows only grow at the end as items arrive', () => {
	let items = running(
		[
			{ type: 'stream', sessionId, event: { type: 'thinking', text: 'hm' } },
			{ type: 'stream', sessionId, event: { type: 'tool_call', id: 'a', name: 'bash', input: {} } },
			{ type: 'tool-results', sessionId, results: [{ type: 'tool_result', id: 'a', output: 'A' }] },
			{ type: 'stream', sessionId, event: { type: 'text', text: 'ok' } },
			{ type: 'turn-end', sessionId, status: 'paused' },
		] as Event[],
		{ type: 'idle' },
	).transcript!.items
	let all = view.rows(items)
	for (let k = 0; k <= items.length; k++) {
		let some = view.rows(items.slice(0, k))
		expect(some.map((r) => r.item)).toEqual(all.slice(0, some.length).map((r) => r.item))
	}
})

test('a sent prompt shows pending, then as the host’s item under the same key, once', () => {
	let st = fold([{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } }] as Event[])
	let sending = [{ id: 'c7', text: 'go' }]
	let before = view.withPending(view.rows(st.transcript!.items, st.sent), sending)
	expect(before.map((r) => [r.key, r.item.type, r.pending])).toEqual([['c7', 'prompt', true]])
	// The durable inbox replaces the optimistic row before acknowledgement,
	// using the same key; it lives in the transcript, not the fixed footer.
	let waiting = [{ id: 'c7', text: 'go', queue: true as const }]
	let queued = view.withPending(view.rows(st.transcript!.items, st.sent), sending, waiting)
	expect(queued.map((r) => [r.key, r.pending, r.waiting])).toEqual([['c7', undefined, 'queued']])
	expect(queued[0]!.item).toMatchObject({ queued: true })
	let steering = view.withPending([], sending, [{ id: 'c7', text: 'go' }])
	expect(steering).toHaveLength(1)
	expect(steering[0]!.item).toMatchObject({ type: 'prompt', text: 'go', steering: true })
	// The host's item arrives before the ack that ends the pending one.
	st = fold([{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake', n: 4, command: 'c7' }] as Event[], st)
	let after = view.withPending(view.rows(st.transcript!.items, st.sent), sending)
	expect(after.map((r) => [r.key, r.item.type, r.pending])).toEqual([['c7', 'prompt', undefined]])
})

test('a prompt’s [image/<name>] markers become links; the rest stays text', () => {
	expect(view.links('see [image/abc123.png] and [image/zz99yy.webp]!')).toEqual(['see ', { href: '/image/abc123.png', text: '[image/abc123.png]' }, ' and ', { href: '/image/zz99yy.webp', text: '[image/zz99yy.webp]' }, '!'])
	expect(view.links('[paste/0005ab.txt] [paste/0005ab.png]')).toEqual([{ href: '/paste/0005ab.txt', text: '[paste/0005ab.txt]' }, ' [paste/0005ab.png]'])
	expect(view.links('[image/ABC123.png] [image 0123456789ab]')).toEqual(['[image/ABC123.png] [image 0123456789ab]'])
})

test('Bash display hides successful status but keeps errors and the original source data', () => {
	let good = { type: 'tool-result' as const, id: 'call', output: '[exit 0]\n M notes.md\n' }
	let bad = { ...good, output: '[exit 123]\nerror: cannot access file\n' }
	expect(view.show(good, false, true)?.text).toBe('◂  M notes.md')
	expect(view.show(bad, false, true)?.text).toContain('[exit 123]\n  error: cannot access file')
	expect(view.show(good, false, false)?.text).toContain('[exit 0]')
	expect(view.show({ type: 'prompt', text: good.output, from: 's', label: 'bash #1813' })?.text).toBe(' M notes.md\n')
	expect(good.output).toStartWith('[exit 0]')
})

test('question URLs preserve OAuth parameters and plain text, excluding prose punctuation', () => {
	let url = 'https://example.com/oauth/authorize?client_id=abc-def&redirect_uri=https%3A%2F%2Fexample.org%2Fcallback&scope=user%3Aprofile&state=a_b#fragment'
	let text = `Open (${url}).\nThen paste code#state; **literal** <script>bad()</script> javascript:bad() data:text/html,bad`
	let parts = view.urlParts(text)
	expect(parts.filter((p) => typeof p !== 'string')).toEqual([{ href: url, text: url }])
	expect(parts.map((p) => typeof p === 'string' ? p : p.text).join('')).toBe(text)
	expect(view.urlParts('See http://example.org/a_(b), then https://example.net/!')).toEqual([
		'See ', { href: 'http://example.org/a_(b)', text: 'http://example.org/a_(b)' }, ', then ',
		{ href: 'https://example.net/', text: 'https://example.net/' }, '!',
	])
})

test('legacy rename suffixes stay hidden without a naming flag', () => {
	expect(view.show({ type: 'text', text: 'Done.\n<rename>Fix replay persistence</rename>\n<summary>Fixed</summary>' })?.text).toBe('Done.')
})
