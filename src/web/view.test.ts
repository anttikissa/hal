import { titles } from '../common/titles.ts'
import { settings } from '../common/settings.ts'
import { expect, test } from 'bun:test'
import type { Event } from '../common/protocol.ts'
import { view, type ViewState } from './view.ts'
import { hrefs } from './hrefs.ts'
import { fold, meta, running, sessionId, ts, useNames } from './view-fixture.test.ts'

useNames()

const shown = (st: ViewState) => st.transcript!.items.map((i) => view.show(i)).filter(Boolean)

test('events fold into what the page shows, like the terminal transcript', () => {
	let st = fold([
		{
			type: 'snapshot',
			sessionId,
			snapshot: {
				meta,
				history: [{ type: 'user', blocks: [{ type: 'text', text: 'old' }], ts }],
				state: { type: 'idle' },
			},
		},
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake' },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'hm' } },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'he' } },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'llo' } },
		{
			type: 'stream',
			sessionId,
			event: { type: 'tool_call', id: 't', name: 'bash', input: { command: 'ls -l', description: 'List files' } },
		},
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
		{ kind: 'tool tool-bash', text: 'bash List files' },
		{ kind: 'result log', text: 'a\nb' },
		{ kind: 'end log', text: 'Paused.' },
		{ kind: 'user prompt', text: 'again' },
		{ kind: 'end error', text: 'error: boom' },
		{ kind: 'user prompt', text: 'ok' },
	])
})

test('long and failed tool results show marked short rows, and all of it in full', () => {
	let output = Array.from({ length: settings.shortRows() + 3 }, (_, i) => `l${i}`).join('\n')
	let s = view.show({ type: 'tool-result', id: 't', output, isError: true })!
	expect(s.kind).toContain('error')
	expect(s.text.startsWith('× l0\n')).toBe(true)
	expect(s.text.split('\n')).toHaveLength(settings.shortRows() + 1)
	expect(s.text.endsWith('… 3 more lines')).toBe(true)
	expect(view.show({ type: 'tool-result', id: 't', output }, true)!.text).toContain(`l${settings.shortRows() + 2}`)
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
	let nudge = view.submit(idle, '  \n')
	expect(nudge).toMatchObject({ command: { type: 'submit', sessionId }, keep: false })
	expect((nudge.command as { text: string }).text.trim()).not.toBe('')
	expect(view.submit(idle, '', 'queue')).toEqual({ keep: false })
	expect(view.submit(idle, '', 'soft-steer')).toEqual({ keep: false })
	expect(view.submit(idle, 'hi')).toEqual({ command: { type: 'submit', sessionId, text: 'hi' }, keep: false })
	expect(view.pause(idle)).toBeUndefined()
	let busy = view.onEvent(idle, { type: 'state', sessionId, state: { type: 'running', phase: 'streaming' } })
	expect(view.submit(busy, '')).toEqual({ keep: false })
	expect(view.submit(busy, 'more')).toEqual({ command: { type: 'submit', sessionId, text: 'more' }, keep: false })
	expect(view.submit(busy, 'later', 'queue')).toEqual({
		command: { type: 'submit', sessionId, text: 'later', delivery: 'queue' },
		keep: false,
	})
	expect(view.pause(busy)).toEqual({ type: 'pause', sessionId })
	let paused = view.onEvent(idle, { type: 'state', sessionId, state: { type: 'paused' } })
	expect(view.submit(paused, '')).toEqual({ command: { type: 'continue', sessionId }, keep: false })
})

test('idle Continue still nudges after a directory command following the final answer', () => {
	let st = fold([
		{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } },
		{ type: 'turn-start', sessionId, prompt: 'fix it', provider: 'fake' },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'May I inspect the project directory?' } },
		{ type: 'turn-end', sessionId, status: 'completed' },
		{ type: 'command', sessionId, text: '/cd' },
		{ type: 'output', sessionId, text: 'Directory changed: /work → /project' },
	])
	let empty = fold([{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } }])
	expect(view.nudge(empty, 0)).toBeTruthy()
	let greeting = fold([
		{
			type: 'snapshot',
			sessionId,
			snapshot: { meta, history: [{ type: 'output', text: 'Hello.', synthetic: true, ts }], state: { type: 'idle' } },
		},
	])
	expect(view.nudge(greeting, 0)).toBeTruthy()
	let text = view.nudge(st, 0)!
	expect(text).toBeTruthy()
	expect(view.submit(st, text)).toEqual({ command: { type: 'submit', sessionId, text }, keep: false })
	for (let state of [
		{ type: 'running', phase: 'streaming' },
		{ type: 'paused' },
		{ type: 'blocked', reason: 'question' },
	] as const) {
		expect(view.nudge(view.onEvent(st, { type: 'state', sessionId, state }), 0)).toBeUndefined()
	}
})

test('a tool gets a class for its name that no name can break out of', () => {
	let kind = view.show({ type: 'tool', id: 't', name: 'My Tool"><x', input: {} })!.kind
	expect(kind.split(' ')[0]).toBe('tool')
	expect(kind.split(' ')[1]).toMatch(/^tool-[a-z0-9-]+$/)
})

test('the open question is filled in with browser keys and answered; afterwards it shows its quote and the answer', () => {
	let form = {
		text: 'Create it?',
		quote: { text: 'rm -rf x', marks: [[0, 8]] as [number, number][] },
		fields: [{ type: 'choice' as const, name: 'ok', options: ['yes', 'no'], initial: 1 }],
	}
	let st = fold([
		{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'blocked', reason: 'question' } } },
		{ type: 'question', sessionId, id: 'q1', form },
	])
	expect(st.form?.id).toBe('q1')
	let browser = (key: string, mods = {}) =>
		view.key({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods })
	expect(browser('Shift')).toBeUndefined()
	let left = view.formKey(st, browser('ArrowLeft')!)
	expect(left.command).toBeUndefined()
	let enter = view.formKey(left.state, browser('Enter')!)
	expect(enter.command).toEqual({ type: 'answer', sessionId, question: 'q1', answers: { ok: 'yes' } })
	expect(view.formKey(st, browser('Escape')!).command).toEqual({ type: 'pause', sessionId })
	st = fold([{ type: 'answer', sessionId, question: 'q1', answers: { ok: 'yes' } }], enter.state)
	expect(st.form).toBeUndefined()
	expect(shown(st)).toEqual([{ kind: 'question warning', text: '  rm -rf x\n\nyes' }])
})

test('Up while the model works edits the last prompt, whatever the input holds; Enter sends it, Down or Escape continues', () => {
	let running = fold([
		{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'running', phase: 'streaming' } } },
		{ type: 'turn-start', sessionId, prompt: 'fix ti', provider: 'fake', n: 5 },
	])
	expect(view.editKey(running, 'up', 'draft')).toMatchObject({ text: 'fix ti' })
	let up = view.editKey(running, 'up', '')!
	expect(up).toMatchObject({ command: { type: 'pause', sessionId }, text: 'fix ti' })
	let editing = fold([{ type: 'state', sessionId, state: { type: 'paused' } }], up.view)
	expect(view.hints(editing, 'fix ti').some(([key]) => key === 'enter')).toBe(false)
	expect(view.submit(editing, 'fix it')).toEqual({
		command: { type: 'submit', sessionId, text: '/edit 5\nfix it' },
		keep: false,
	})
	expect(view.editKey(editing, 'down', 'fix it')).toBeUndefined()
	let down = view.editKey(editing, 'down', 'fix ti')!
	expect(down).toEqual({ view: { ...editing, editing: undefined }, command: { type: 'continue', sessionId }, text: '' })
	expect(view.editKey(editing, 'escape', 'fix it')).toEqual({
		view: { ...editing, editing: undefined },
		command: { type: 'continue', sessionId },
		text: '',
	})
})

test('commands show who sent them, and their output; a canceled question says so', () => {
	let form = { text: 'Create?', fields: [{ type: 'choice' as const, name: 'create', options: ['yes', 'no'] }] }
	let st = fold([
		{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } },
		{ type: 'command', sessionId, text: '/help' },
		{ type: 'output', sessionId, text: 'Commands' },
		{ type: 'command', sessionId, text: '/cd x', from: '7-abc' },
		{ type: 'question', sessionId, id: 'q', form },
		{ type: 'answer', sessionId, question: 'q', answers: {}, canceled: true },
		{ type: 'output', sessionId, text: 'nope', error: true },
	])
	let texts = shown(st).map((s) => s!.text)
	expect(texts[0]).toBe('Commands')
	expect(texts[1]).toBe('/cd x')
	expect(shown(st)[0]!.kind).toBe('output plain')
	expect(shown(st)[1]!.kind).toBe('message prompt')
	expect(titles.who(st.transcript!.items[1]!)).toBe('Command from 7-abc')
	expect(texts[2]).toContain('(canceled)')
	expect(shown(st)[3]!.kind).toContain('error')
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
	expect(
		view.commandKey(st, view.key({ key: 'm', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })!, false),
	).toEqual({ type: 'models', sessionId })
	expect(
		view.commandKey(st, view.key({ key: 'm', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })!, false),
	).toBeUndefined()
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

test('the status line says what the session is doing, like the terminal', () => {
	let line = (st: ViewState, connected = true) => view.line(st, connected)
	let idle = running([], { type: 'idle' })
	expect(line(idle)).toEqual({ text: 'idle', tone: 'idle' })
	let asking = running([], { type: 'running', phase: 'requesting' })
	expect(line(asking)).toEqual({ text: 'processing', tone: 'busy' })
	let thinking = running([{ type: 'stream', sessionId, event: { type: 'thinking', text: 'hm' } }] as Event[], {
		type: 'running',
		phase: 'streaming',
	})
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
	expect(line(running(calls, { type: 'running', phase: 'tools' }))).toEqual({
		text: 'running bash, read',
		tone: 'busy',
	})
	// Nothing streams into a tool call or while idle: the cursor has a
	// line of its own.
	expect(view.streaming(running(calls, { type: 'running', phase: 'streaming' }))).toBeUndefined()
	expect(
		view.streaming(
			running([{ type: 'stream', sessionId, event: { type: 'text', text: 'hi' } }] as Event[], { type: 'idle' }),
		),
	).toBeUndefined()
	let one = running(
		[...calls, { type: 'tool-results', sessionId, results: [{ type: 'tool_result', id: 'a', output: '' }] }] as Event[],
		{ type: 'running', phase: 'tools' },
	)
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

test('a prompt’s [image/<name>] markers become links; the rest stays text', () => {
	expect(hrefs.links('see [image/abc123.png] and [image/zz99yy.webp]!')).toEqual([
		'see ',
		{ href: '/image/abc123.png', text: '[image/abc123.png]' },
		' and ',
		{ href: '/image/zz99yy.webp', text: '[image/zz99yy.webp]' },
		'!',
	])
	expect(hrefs.links('[paste/0005ab.txt] [paste/0005ab.png]')).toEqual([
		{ href: '/paste/0005ab.txt', text: '[paste/0005ab.txt]' },
		' [paste/0005ab.png]',
	])
	expect(hrefs.links('[image/ABC123.png] [image 0123456789ab]')).toEqual(['[image/ABC123.png] [image 0123456789ab]'])
})

test('Bash headers own status; output and original source data remain complete', () => {
	let good = { type: 'tool-result' as const, id: 'call', output: '[exit 0]\n M notes.md\n' }
	let bad = { ...good, output: '[exit 123]\nerror: cannot access file\n' }
	expect(view.show(good, false, true)?.text).toBe(' M notes.md')
	expect(view.show(bad, false, true)?.text).toBe('error: cannot access file')
	expect(view.show(good, false, false)?.text).toContain('[exit 0]')
	expect(view.show({ type: 'prompt', text: good.output, from: 's', label: 'bash #1813' })?.text).toBe(' M notes.md')
	expect(good.output).toStartWith('[exit 0]')
})

test('question URLs preserve OAuth parameters and plain text, excluding prose punctuation', () => {
	let url =
		'https://example.com/oauth/authorize?client_id=abc-def&redirect_uri=https%3A%2F%2Fexample.org%2Fcallback&scope=user%3Aprofile&state=a_b#fragment'
	let text = `Open (${url}).\nThen paste code#state; **literal** <script>bad()</script> javascript:bad() data:text/html,bad`
	let parts = hrefs.urlParts(text)
	expect(parts.filter((p) => typeof p !== 'string')).toEqual([{ href: url, text: url }])
	expect(parts.map((p) => (typeof p === 'string' ? p : p.text)).join('')).toBe(text)
	expect(hrefs.urlParts('See http://example.org/a_(b), then https://example.net/!')).toEqual([
		'See ',
		{ href: 'http://example.org/a_(b)', text: 'http://example.org/a_(b)' },
		', then ',
		{ href: 'https://example.net/', text: 'https://example.net/' },
		'!',
	])
})

test('legacy rename suffixes stay hidden without a naming flag', () => {
	expect(
		view.show({ type: 'text', text: 'Done.\n<rename>Fix replay persistence</rename>\n<summary>Fixed</summary>' })?.text,
	).toBe('Done.')
	expect(view.show({ type: 'text', text: '<summary>Stopped.</summary>' })?.text).toBe('Stopped.')
})
