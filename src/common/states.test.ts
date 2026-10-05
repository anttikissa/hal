import { expect, test } from 'bun:test'
import type { HistoryRecord, TurnStatus } from './replay.ts'
import { states, type SessionState, type StateEvent } from './states.ts'
import type { Shown } from './transcript.ts'

const idle: SessionState = { type: 'idle' }
const requesting: SessionState = { type: 'running', phase: 'requesting' }
const streaming: SessionState = { type: 'running', phase: 'streaming' }
const tools: SessionState = { type: 'running', phase: 'tools' }
const retrying: SessionState = { type: 'retrying', at: '2026-09-26T12:00:00.000Z', reason: '529 overloaded' }
const blocked: SessionState = { type: 'blocked', reason: 'log in to anthropic' }
const paused: SessionState = { type: 'paused' }
const error: SessionState = { type: 'error', message: '400 bad request' }
const asking: SessionState = { type: 'blocked', reason: 'question' }
const all = [idle, requesting, streaming, tools, retrying, blocked, asking, paused, error]

const events: StateEvent[] = [
	{ type: 'submit' },
	{ type: 'continue' },
	{ type: 'request' },
	{ type: 'stream' },
	{ type: 'tools' },
	{ type: 'pause' },
	{ type: 'pause', reason: 'why' },
	{ type: 'end' },
	{ type: 'end', error: 'boom' },
	{ type: 'retry', at: '2026-09-26T12:00:12.000Z', reason: 'connection lost' },
	{ type: 'block', reason: 'log in' },
	{ type: 'block', reason: 'question' },
	{ type: 'answer' },
]

const refused = expect.any(String)
const ts12 = '2026-09-26T12:00:12.000Z'

// [state, event, next state, or refused]
const table: [SessionState, StateEvent, SessionState | typeof refused][] = [
	// Only the user starts work.
	[idle, { type: 'submit' }, requesting],
	[paused, { type: 'submit' }, requesting],
	[error, { type: 'submit' }, requesting],
	// Sending while busy steers: the turn goes on as it was.
	[streaming, { type: 'submit' }, streaming],
	[retrying, { type: 'submit' }, retrying],
	[blocked, { type: 'submit' }, blocked],
	[paused, { type: 'continue' }, requesting],
	[error, { type: 'continue' }, requesting],
	[idle, { type: 'continue' }, refused],
	[tools, { type: 'continue' }, refused],
	// A turn moves through its phases.
	[requesting, { type: 'stream' }, streaming],
	[streaming, { type: 'tools' }, tools],
	[tools, { type: 'request' }, requesting],
	[retrying, { type: 'request' }, requesting],
	// Late turn events change nothing once it stopped.
	[paused, { type: 'stream' }, paused],
	[idle, { type: 'tools' }, idle],
	[error, { type: 'request' }, error],
	// Only running work pauses; paused keeps its reason.
	[streaming, { type: 'pause' }, paused],
	[retrying, { type: 'pause' }, paused],
	[blocked, { type: 'pause' }, paused],
	[tools, { type: 'pause', reason: 'loop' }, { type: 'paused', reason: 'loop' }],
	[idle, { type: 'pause' }, refused],
	[paused, { type: 'pause' }, refused],
	[error, { type: 'pause' }, refused],
	// A turn ends completed or failed.
	[streaming, { type: 'end' }, idle],
	[requesting, { type: 'end', error: 'boom' }, { type: 'error', message: 'boom' }],
	[retrying, { type: 'end', error: 'boom' }, { type: 'error', message: 'boom' }],
	[paused, { type: 'end' }, paused],
	// Failures the host fixes itself: retrying at a time, or blocked on a human.
	[streaming, { type: 'retry', at: ts12, reason: 'connection lost' }, { type: 'retrying', at: ts12, reason: 'connection lost' }],
	[blocked, { type: 'retry', at: ts12, reason: 'rate limited' }, { type: 'retrying', at: ts12, reason: 'rate limited' }],
	[requesting, { type: 'block', reason: 'log in' }, { type: 'blocked', reason: 'log in' }],
	[retrying, { type: 'block', reason: 'log in' }, { type: 'blocked', reason: 'log in' }],
	[blocked, { type: 'request' }, requesting],
	// A late failure after a pause changes nothing.
	[paused, { type: 'retry', at: ts12, reason: 'x' }, paused],
	[idle, { type: 'block', reason: 'x' }, idle],
	// A question blocks the turn until the first answer re-runs it.
	[streaming, { type: 'block', reason: 'question' }, asking],
	[asking, { type: 'answer' }, requesting],
	// A message sent meanwhile waits in the inbox (steering).
	[asking, { type: 'submit' }, asking],
	[asking, { type: 'pause' }, paused],
	[requesting, { type: 'answer' }, refused],
	[blocked, { type: 'answer' }, refused],
	[paused, { type: 'answer' }, refused],
]

test.each(table)('%o on %o', (state, event, next) => {
	expect(states.step(state, event)).toEqual(next)
})

test('every state but idle, paused and error names what ends it', () => {
	let seen: SessionState[] = [...all]
	for (let s of all) for (let e of events) {
		let next = states.step(s, e)
		if (typeof next !== 'string') seen.push(next)
	}
	for (let s of seen) {
		if (s.type === 'running') expect(['requesting', 'streaming', 'tools']).toContain(s.phase)
		else if (s.type === 'retrying') expect(!isNaN(Date.parse(s.at)) && s.reason.length > 0).toBe(true)
		else if (s.type === 'blocked') expect(s.reason.length).toBeGreaterThan(0)
		else expect(['idle', 'paused', 'error']).toContain(s.type)
	}
})

test('nothing but a pause stops work: no event takes a busy state to paused otherwise', () => {
	for (let s of [requesting, streaming, tools, retrying, blocked])
		for (let e of events) {
			let next = states.step(s, e)
			if (typeof next !== 'string' && next.type === 'paused') expect(e.type).toBe('pause')
		}
})

const ts = '2026-01-01T00:00:00.000Z'
const say = (text: string): HistoryRecord => ({ type: 'user', blocks: [{ type: 'text', text }], ts })
const out = (text: string): HistoryRecord => ({ type: 'assistant', block: { type: 'text', text }, ts })
const end = (status: TurnStatus, extra = {}): HistoryRecord => ({ type: 'turn_end', status, usage: {}, ts, ...extra })
const cont: HistoryRecord = { type: 'continue', ts }
const waiting = (id: string): HistoryRecord => ({ type: 'inbox', id, text: id, ts })
const ask = (id: string): HistoryRecord => ({ type: 'question', id, form: { text: 'Name?', fields: [{ type: 'text', name: 'name' }] }, ts })
const reply = (id: string): HistoryRecord => ({ type: 'answer', question: id, answers: { name: 'Dave' }, ts })

test('history alone: an unfinished turn is running, ends say the rest', () => {
	expect(states.fromHistory([])).toEqual(idle)
	expect(states.fromHistory([say('a')])).toEqual(requesting)
	expect(states.fromHistory([say('a'), out('b')])).toEqual(requesting)
	expect(states.fromHistory([say('a'), end('paused'), cont])).toEqual(requesting)
	expect(states.fromHistory([say('a'), end('completed')])).toEqual(idle)
	expect(states.fromHistory([say('a'), end('error', { error: '400 nope' })])).toEqual({ type: 'error', message: '400 nope' })
	expect(states.fromHistory([say('a'), end('paused')])).toEqual(paused)
	expect(states.fromHistory([say('a'), end('paused', { pauseReason: 'loop' })])).toEqual({ type: 'paused', reason: 'loop' })
	// The old Escape and the old restart could both continue.
	expect(states.fromHistory([say('a'), end('canceled')])).toEqual(paused)
	expect(states.fromHistory([say('a'), end('interrupted')])).toEqual(paused)
})

test('history alone: an open question blocks the turn until answered or paused', () => {
	expect(states.fromHistory([say('a'), out('hi'), ask('q1')])).toEqual(asking)
	expect(states.fromHistory([say('a'), ask('q1'), reply('q1')])).toEqual(requesting)
	expect(states.fromHistory([say('a'), ask('q1'), reply('q1'), out('x'), ask('q2')])).toEqual(asking)
	// Escape while it waited: paused, and continuing asks again.
	expect(states.fromHistory([say('a'), ask('q1'), end('paused')])).toEqual(paused)
	expect(states.fromHistory([say('a'), ask('q1'), end('paused'), cont])).toEqual(requesting)
})

const typed = (text: string): HistoryRecord => ({ type: 'command', text, ts })
const said = (text: string): HistoryRecord => ({ type: 'output', text, ts })
const cmdAsk = (id: string): HistoryRecord => ({ type: 'question', id, form: { text: 'Create?', fields: [{ type: 'choice', name: 'create', options: ['yes', 'no'] }] }, from: { command: 'cd', args: 'x' }, ts })
const cmdReply = (id: string): HistoryRecord => ({ type: 'answer', question: id, answers: { create: 'no' }, ts })

test('history alone: commands leave the turn state as it was, even while one asks', () => {
	for (let before of [[], [say('a'), end('completed')], [say('a'), end('paused')], [say('a'), end('error', { error: 'x' })], [say('a'), out('b')]] as HistoryRecord[][]) {
		let state = states.fromHistory(before)
		expect(states.fromHistory([...before, typed('/help'), said('help')])).toEqual(state)
		expect(states.fromHistory([...before, typed('/cd x'), cmdAsk('c1'), cmdReply('c1'), said('ok')])).toEqual(state)
		expect(states.fromHistory([...before, typed('/cd x'), cmdAsk('c1')])).toEqual(state)
	}
	expect(states.recoveries([say('a'), cont, out('x'), typed('/help'), said('h'), cont])).toBe(2)
	// A message waiting while a command asked starts nothing by itself.
	expect(states.fromHistory([say('a'), end('completed'), typed('/cd x'), cmdAsk('c1'), waiting('m'), cmdReply('c1')])).toEqual(idle)
})

test('recoveries counts continues since the last finished round, partial output aside', () => {
	expect(states.recoveries([say('a')])).toBe(0)
	expect(states.recoveries([say('a'), cont, out('x'), cont, out('y')])).toBe(2)
	// A finished round (tool results) or a turn end is progress.
	expect(states.recoveries([say('a'), cont, cont, say('results'), cont])).toBe(1)
	expect(states.recoveries([say('a'), cont, end('paused'), cont])).toBe(1)
	// A message waiting in the inbox is not progress.
	expect(states.recoveries([say('a'), cont, waiting('m'), cont])).toBe(2)
})

test('describe says when a retry happens and why', () => {
	let at = Date.parse('2026-09-26T12:00:12.000Z')
	let s: SessionState = { type: 'retrying', at: new Date(at).toISOString(), reason: 'connection lost' }
	expect(states.describe(s, at - 12_000)).toBe('retrying in 12s (connection lost)')
	expect(states.describe(s, at - 3 * 3600_000 - 5 * 60_000)).toBe('retrying in 3h 5m (connection lost)')
	expect(states.describe(s, at + 1000)).toBe('retrying now (connection lost)')
	// Without a clock: the time itself, which never goes stale.
	expect(states.describe(s)).toContain('connection lost')
})

test('a turn says processing until the first streamed byte, then thinking or writing', () => {
	let say = (phase: 'requesting' | 'streaming' | 'tools', items: Shown[] = []) => states.describe({ type: 'running', phase }, undefined, items)
	// Waiting for the provider: the model is not thinking yet.
	expect(say('requesting')).toBe('processing')
	expect(say('requesting', [{ type: 'thinking', text: 'earlier round' }])).toBe('processing')
	expect(say('streaming', [{ type: 'thinking', text: 'hm' }])).toBe('thinking')
	expect(say('streaming', [{ type: 'thinking', text: 'hm' }, { type: 'text', text: 'hi' }])).toBe('writing')
	expect(say('tools', [{ type: 'tool', id: 'a', name: 'bash', input: {} }])).toBe('running bash')
})

test('describe speaks plain words, never internal state or phase names', () => {
	let internal = /\b(blocked|requesting|streaming|question)\b/
	let shown: SessionState[] = [
		{ type: 'running', phase: 'requesting' },
		{ type: 'running', phase: 'streaming' },
		{ type: 'running', phase: 'tools' },
		{ type: 'blocked', reason: 'log in: token expired' },
		{ type: 'paused' },
		{ type: 'error', message: 'boom' },
	]
	for (let s of shown) expect(states.describe(s)).not.toMatch(internal)
	// A login says what to do; an open question is on screen already.
	expect(states.describe({ type: 'blocked', reason: 'log in: token expired' })).toContain('log in')
	expect(states.describe({ type: 'blocked', reason: 'question' })).toBeUndefined()
	expect(states.describe({ type: 'idle' })).toBeUndefined()
})

test('Enter with text always sends: a prompt, or while busy a steer; Alt-Enter queues', () => {
	for (let s of all) expect(states.enter('s', s, 'hi')).toEqual({ command: { type: 'submit', sessionId: 's', text: 'hi' } })
	expect(states.enter('s', streaming, 'later', true)).toEqual({ command: { type: 'submit', sessionId: 's', text: 'later', queue: true } })
	// Bare Enter still only continues.
	expect(states.enter('s', streaming, '  ')).toEqual({})
	expect(states.enter('s', paused, '', true)).toEqual({ command: { type: 'continue', sessionId: 's' } })
})
