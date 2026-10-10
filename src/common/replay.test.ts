import { expect, test } from 'bun:test'
import type { AssistantBlock, Message, UserBlock } from './blocks.ts'
import { inbox } from './inbox.ts'
import { replay, type HistoryRecord, type TurnStatus } from './replay.ts'

const ts = '2026-01-01T00:00:00.000Z'
const user = (...blocks: UserBlock[]): HistoryRecord => ({ type: 'user', blocks, ts })
const say = (text: string, at = ts): HistoryRecord & { type: 'user' } => ({ type: 'user', blocks: [{ type: 'text', text }], ts: at })
const block = (b: AssistantBlock): HistoryRecord => ({ type: 'assistant', block: b, ts })
const end = (status: TurnStatus, more: { error?: string; pauseReason?: string } = {}): HistoryRecord => ({ type: 'turn_end', status, usage: {}, ts, ...more })
const call = (id: string): AssistantBlock => ({ type: 'tool_call', id, name: 'bash', input: { cmd: 'ls' } })
const cont: HistoryRecord = { type: 'continue', ts }

// The prompt texts the model gets, one per user message with text.
const prompts = (msgs: Message[]) => msgs.filter((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text')).map((m) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''))

// Local wall-clock time and date of an ISO timestamp, as a person would read them.
const two = (n: number) => String(n).padStart(2, '0')
const hhmm = (iso: string) => {
	let d = new Date(iso)
	return `${two(d.getHours())}:${two(d.getMinutes())}`
}
const day = (iso: string) => {
	let d = new Date(iso)
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

test('a normal two-turn history: each prompt its own message, stamped with its time, no notes', () => {
	let first = new Date(2026, 0, 1, 9, 7).toISOString()
	let second = new Date(2026, 0, 1, 10, 42).toISOString()
	let msgs = replay.toMessages([
		say('hi', first),
		block({ type: 'thinking', text: 'hmm', signature: 'sig', provider: 'anthropic' }),
		block({ type: 'text', text: 'hello' }),
		end('completed'),
		say('again', second),
		block({ type: 'text', text: 'yes' }),
		end('completed'),
	])
	expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
	expect(msgs[1]!.blocks).toEqual([
		{ type: 'thinking', text: 'hmm', signature: 'sig', provider: 'anthropic' },
		{ type: 'text', text: 'hello' },
	])
	expect(msgs[3]!.blocks).toEqual([{ type: 'text', text: 'yes' }])
	expect(prompts(msgs)).toEqual([`[${day(first)} ${hhmm(first)}]\nhi`, `[${hhmm(second)}]\nagain`])
})

test('the stamp names the date on the first prompt and whenever the date changed since the last one', () => {
	let late = new Date(2026, 0, 1, 23, 1).toISOString()
	let early = new Date(2026, 0, 2, 0, 36).toISOString()
	let later = new Date(2026, 0, 2, 9, 0).toISOString()
	let weekOn = new Date(2026, 0, 9, 9, 0).toISOString()
	let msgs = replay.toMessages([say('a', late), end('completed'), say('b', early), end('completed'), say('c', later), end('completed'), say('d', weekOn)])
	expect(prompts(msgs)).toEqual([`[2026-01-01 23:01]\na`, `[2026-01-02 00:36]\nb`, `[09:00]\nc`, `[2026-01-09 09:00]\nd`])
	// A later prompt never changes how earlier ones read (prompt caching).
	let more = replay.toMessages([say('a', late), end('completed'), say('b', early), end('completed'), say('c', later), end('completed'), say('d', weekOn), end('completed'), say('e', weekOn)])
	expect(prompts(more).slice(0, 4)).toEqual(prompts(msgs))
})

test('a failure notice stays separate from both prompts and keeps the whole error', () => {
	let error = `HTTP 400: ${'provider detail '.repeat(100)}last byte`
	let msgs = replay.toMessages([say('Say just the word pong'), end('error', { error }), say('k')])
	let [one, notice, next] = prompts(msgs)
	expect(msgs).toHaveLength(3)
	expect(one).toMatch(/\nSay just the word pong$/)
	expect(notice).toContain(error)
	expect(next).toMatch(/^\[[\d -]+:\d\d\]\nk$/)
})

test('a pause notice identifies who paused, independently of the next prompt', () => {
	let byUser = prompts(replay.toMessages([say('go'), block({ type: 'text', text: 'hal' }), end('paused'), say('stop that')]))
	expect(byUser[1]).toContain('user paused')
	expect(byUser[2]).toMatch(/\nstop that$/)
	let byHal = prompts(replay.toMessages([say('go'), end('paused', { pauseReason: 'kept crashing' }), say('why?')]))
	expect(byHal[1]).toContain('Hal paused the turn: kept crashing')
	expect(byHal[1]).not.toContain('user paused')
})

test('notices appear once at their delivery point, not on later prompts', () => {
	let msgs = replay.toMessages([
		say('one'),
		end('error', { error: 'boom' }),
		say('two'),
		block({ type: 'text', text: 'ok' }),
		end('completed'),
		say('three'),
		block({ type: 'text', text: 'half' }),
		end('paused'),
		cont,
		block({ type: 'text', text: 'rest' }),
		end('completed'),
		say('four'),
	])
	let texts = prompts(msgs)
	expect(texts.filter((t) => t.includes('<hal-note>'))).toHaveLength(2)
	expect(texts[1]).toContain('boom')
	expect(texts.at(-1)).not.toContain('<hal-note>')
})

test('partial text of a canceled turn is kept; unsigned thinking is not replayed', () => {
	let msgs = replay.toMessages([
		say('hi'),
		block({ type: 'thinking', text: 'half a thou' }),
		end('canceled'),
		say('go on'),
		block({ type: 'thinking', text: 'x' }),
		block({ type: 'text', text: 'partial ans' }),
		end('canceled'),
	])
	expect(msgs.flatMap((m) => m.role === 'assistant' ? m.blocks : [])).toEqual([{ type: 'text', text: 'partial ans' }])
	expect(msgs[3]!.blocks).toEqual([{ type: 'text', text: 'partial ans' }])
})

test('tool calls get their results; unanswered ones get an error result before the next prompt', () => {
	let msgs = replay.toMessages([
		say('run'),
		block(call('a')),
		block(call('b')),
		end('completed'),
		user({ type: 'tool_result', id: 'a', output: 'ok' }),
		block(call('c')),
		end('canceled'),
		say('never mind'),
	])
	expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'user', 'user'])
	let [, , results1, , results2, , next] = msgs
	let ids1 = results1!.blocks.map((b) => b.type === 'tool_result' && b.id)
	expect(ids1.sort()).toEqual(['a', 'b'])
	expect(results1!.blocks.find((b) => b.type === 'tool_result' && b.id === 'a')).toMatchObject({ output: 'ok' })
	expect(results1!.blocks.find((b) => b.type === 'tool_result' && b.id === 'b')).toMatchObject({ isError: true })
	// Results come first, then the prompt.
	expect(results2!.blocks).toEqual([expect.objectContaining({ type: 'tool_result', id: 'c', isError: true })])
	expect(next!.blocks).toEqual([{ type: 'text', text: expect.stringMatching(/\nnever mind$/) }])
})

test('tool results without a matching call are dropped', () => {
	let msgs = replay.toMessages([say('x'), end('interrupted'), user({ type: 'tool_result', id: 'ghost', output: '' }), say('y')])
	expect(msgs.flatMap((m): { type: string }[] => m.blocks).every((b) => b.type === 'text')).toBe(true)
	expect(prompts(msgs)).toHaveLength(3)
})

test('a turn continued after a host went away tells the model, and cut-off calls may have run', () => {
	let msgs = replay.toMessages([say('go'), block({ type: 'text', text: 'half' }), block(call('a')), cont, block({ type: 'text', text: 'rest' })])
	expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant'])
	let result = msgs[2]!.blocks[0]
	expect(result).toMatchObject({ type: 'tool_result', id: 'a', isError: true })
	expect((result as any).output).toMatch(/may or may not have run/)
	expect(JSON.stringify(msgs[3])).toContain('unfinished turn is continuing')
})

test('continuing after tool results keeps them intact and describes the pause and resume', () => {
	let result = { type: 'tool_result' as const, id: 'a', output: 'ok' }
	let msgs = replay.toMessages([say('go'), block(call('a')), user(result), end('paused'), cont])
	expect(msgs[2]).toEqual({ role: 'user', blocks: [result] })
	expect(JSON.stringify(msgs.at(-1))).toContain('user resumed the paused turn')
	expect(JSON.stringify(msgs.at(-1))).not.toContain('response was interrupted')
})

test('continuation reports failure versus pause rather than inventing an interrupted answer', () => {
	let paused = replay.toMessages([say('go'), block({ type: 'text', text: 'half' }), end('paused'), cont])
	expect(JSON.stringify(paused.at(-1))).toContain('user resumed the paused turn')
	let failed = replay.toMessages([say('go'), end('error', { error: 'bad request' }), cont])
	expect(JSON.stringify(failed.at(-1))).toContain('asked to retry the failed turn')
	expect(JSON.stringify(failed.at(-1))).toContain('bad request')
	expect(JSON.stringify(failed)).not.toContain('response was interrupted')
})

test('waiting inbox messages are not sent; once delivered they are one prompt, oldest first', () => {
	let waiting: HistoryRecord[] = [say('go'), block({ type: 'text', text: 'working' }), { type: 'inbox', id: 'a', text: 'one', ts }, { type: 'inbox', id: 'b', text: 'two', delivery: 'after-turn', ts }]
	let before = replay.toMessages(waiting)
	expect(prompts(before)).toHaveLength(1)
	let after = replay.toMessages([...waiting, { type: 'user', blocks: [{ type: 'text', text: 'one' }, { type: 'text', text: 'three' }], inbox: ['a'], ts }])
	expect(after.slice(0, before.length)).toEqual(before)
	// One text block: providers join blocks with no separator.
	expect(after.at(-1)!.blocks).toEqual([{ type: 'text', text: `[${hhmm(ts)}]\none\n\n[${hhmm(ts)}]\nthree` }])
})

test('an edited prompt supersedes the prompt it replaces and that turn, as if written that way', () => {
	let replaced: HistoryRecord = { type: 'user', blocks: [{ type: 'text', text: 'fix it' }], replaces: true, ts }
	let before = [say('hi'), block({ type: 'text', text: 'hello' }), end('error', { error: 'boom' })]
	let msgs = replay.toMessages([
		...before,
		say('fix ti'),
		block({ type: 'text', text: 'Looking' }),
		block({ type: 'tool_call', id: 'r1', name: 'read', input: { path: 'x' } }),
		user({ type: 'tool_result', id: 'r1', output: 'x' }),
		end('paused'),
		cont,
		{ type: 'inbox', id: 'm1', text: 'waiting', ts },
		end('paused'),
		replaced,
	])
	expect(msgs).toEqual(replay.toMessages([...before, say('fix it')]))
	// The prompt before it is not touched; a second edit replaces the first.
	let again: HistoryRecord = { ...replaced, blocks: [{ type: 'text', text: 'fix it now' }] }
	expect(replay.toMessages([...before, say('fix ti'), end('paused'), replaced, end('paused'), again])).toEqual(replay.toMessages([...before, say('fix it now')]))
})

test('editing a prompt that delivered a waiting message never makes it wait again', () => {
	let raw: HistoryRecord[] = [say('go'), { type: 'inbox', id: 'm1', text: 'typo', ts }, { ...say('typo'), inbox: ['m1'] }, end('paused'), { ...say('fixed'), replaces: true }]
	expect(inbox.pending(replay.current(raw))).toEqual([])
})

test('setting transitions do not duplicate rendered instruction update notices', () => {
	let before = [say('hi'), { ...block({ type: 'text', text: 'hello' }), model: 'hal/intro' }]
	let records: HistoryRecord[] = [...before, { type: 'change', cwd: '/a', model: 'anthropic/opus', ts }]
	expect(replay.toMessages(records)).toEqual(replay.toMessages(before))
	let messages = replay.toMessages([...records, { type: 'notice', text: 'New instructions for /a', sectionUpdate: true, ts }])
	expect(prompts(messages).at(-1)).toContain('New instructions for /a')
	expect(prompts(messages).at(-1)).not.toContain('changed from')
})

test('a change is not a turn: withoutCommands drops it', () => {
	let records: HistoryRecord[] = [say('hi'), end('completed'), { type: 'change', cwd: '/x', ts }]
	expect(replay.withoutCommands(records).at(-1)).toEqual(end('completed'))
})

test('queued texts retain exact receipt timestamps independently of delivery and neighboring texts', () => {
	let queuedAt = '2026-10-04T20:13:07.456Z'
	let deliveredAt = '2026-10-04T20:17:42.123Z'
	let msgs = replay.toMessages([{
		type: 'user', ts: deliveredAt,
		blocks: [
			{ type: 'text', text: 'That was the situation then.', queuedAt },
			{ type: 'text', text: 'A fresh message.' },
			{ type: 'text', text: 'A queued agent message.', from: 'reviewer', queuedAt },
		],
	}])
	expect(prompts(msgs)).toEqual([
		`[${day(deliveredAt)} ${hhmm(deliveredAt)}; queued at ${hhmm(queuedAt)}]\n<hal-note>Message was queued at ${queuedAt}, take that into account when reading it.</hal-note>\nThat was the situation then.\n\n[${hhmm(deliveredAt)}]\nA fresh message.\n\n[${hhmm(deliveredAt)}; message from reviewer; queued at ${hhmm(queuedAt)}]\n<hal-note>Message was queued at ${queuedAt}, take that into account when reading it.</hal-note>\nA queued agent message.`,
	])
})

// Task c2t: headers give the model the block ids, times and delivery
// facts the transcript shows. A format contract: exact text.
test('replay headers carry block ids, steering, durations and what the model wrote', () => {
	let at = (h: number, m: number, s = 0) => new Date(2026, 0, 1, h, m, s).toISOString()
	let history: HistoryRecord[] = [
		{ type: 'user', blocks: [{ type: 'text', text: 'go' }], ts: at(12, 33), n: 1 },
		{ type: 'assistant', block: { type: 'thinking', text: 'hmm', signature: 's', provider: 'anthropic' }, ts: at(12, 33), n: 2 },
		{ type: 'assistant', block: { type: 'text', text: 'Running it.' }, ts: at(12, 34), n: 3 },
		{ type: 'assistant', block: { type: 'tool_call', id: 'toolu_1', name: 'bash', input: { command: './test' } }, ts: at(12, 34), n: 4 },
		{ type: 'user', blocks: [{ type: 'tool_result', id: 'toolu_1', output: 'ok', ms: 8100 }], ts: at(12, 34, 9), n: 5 },
		{ type: 'user', blocks: [{ type: 'text', text: 'hurry', from: '160-xyz', label: 'tab 3 · 160-xyz · Builder', delivery: 'now' }], ts: at(12, 40), n: 6 },
		{ type: 'assistant', block: { type: 'text', text: 'Done.' }, ts: at(12, 41), n: 7, originSession: '160-abc' },
		{ type: 'turn_end', status: 'completed', usage: {}, ts: at(12, 41), n: 8 },
		{ type: 'user', blocks: [{ type: 'text', text: 'thanks' }], ts: at(12, 42), n: 9 },
	]
	let msgs = replay.toMessages(history)
	expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant', 'user'])
	expect(msgs[0]!.blocks).toEqual([{ type: 'text', text: '[2026-01-01 12:33 #u1]\ngo' }])
	// Assistant blocks reach the provider as produced; calls as Action text.
	expect(msgs[1]!.blocks).toEqual([{ type: 'thinking', text: 'hmm', signature: 's', provider: 'anthropic' }, { type: 'text', text: 'Running it.' }, { type: 'tool_call', id: 'toolu_1', name: 'Action', input: { action: "BASH { command: './test' }" } }])
	expect(msgs[2]!.blocks).toEqual([{ type: 'tool_result', id: 'toolu_1', output: '[12:34 #t4; 8.1s; you wrote #r2 #a3]\nok', ms: 8100 }])
	expect(msgs[3]!.blocks).toEqual([{ type: 'text', text: '[12:40 #m6; message from tab 3 (160-xyz), Builder; steering]\nhurry' }])
	expect(msgs[5]!.blocks).toEqual([{ type: 'text', text: '[12:42 #u9; you wrote #a7]\nthanks' }])
	// Appending never changes earlier provider input.
	let more = replay.toMessages([...history, { type: 'assistant', block: { type: 'text', text: 'Welcome.' }, ts: at(12, 43), n: 10 }, { type: 'user', blocks: [{ type: 'text', text: 'bye' }], ts: at(12, 44), n: 11 }])
	expect(JSON.stringify(more.slice(0, msgs.length))).toBe(JSON.stringify(msgs))
})
