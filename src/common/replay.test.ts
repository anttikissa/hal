import { expect, test } from 'bun:test'
import type { AssistantBlock, Message, UserBlock } from './blocks.ts'
import { replay, type HistoryRecord, type TurnStatus } from './replay.ts'

const ts = '2026-01-01T00:00:00.000Z'
const user = (...blocks: UserBlock[]): HistoryRecord => ({ type: 'user', blocks, ts })
const say = (text: string, at = ts): HistoryRecord => ({ type: 'user', blocks: [{ type: 'text', text }], ts: at })
const block = (b: AssistantBlock): HistoryRecord => ({ type: 'assistant', block: b, ts })
const end = (status: TurnStatus, more: { error?: string; pauseReason?: string } = {}): HistoryRecord => ({ type: 'turn_end', status, usage: {}, ts, ...more })
const call = (id: string): AssistantBlock => ({ type: 'tool_call', id, name: 'bash', input: { cmd: 'ls' } })
const cont: HistoryRecord = { type: 'continue', ts }

// The prompt texts the model gets, one per user message with text.
const prompts = (msgs: Message[]) => msgs.filter((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text')).map((m) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''))

// Local wall-clock time of an ISO timestamp, as a person would read it.
const hhmm = (iso: string) => {
	let d = new Date(iso)
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

test('a normal two-turn history: each prompt its own message, stamped with its time, no notes', () => {
	let first = '2026-01-01T09:07:00.000Z'
	let second = '2026-01-01T10:42:00.000Z'
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
	expect(prompts(msgs)).toEqual([`[${hhmm(first)}]\nhi`, `[${hhmm(second)}]\nagain`])
})

test('a prompt after an errored turn stays separate and says the turn failed', () => {
	let msgs = replay.toMessages([say('Say just the word pong'), end('error', { error: 'HTTP 400: prompt too long' }), say('k')])
	let [one, two] = prompts(msgs)
	expect(msgs).toHaveLength(2)
	expect(one).toMatch(/\nSay just the word pong$/)
	expect(two).toMatch(/^\[\d\d:\d\d\]\n<meta>[^<]*fail[^<]*HTTP 400: prompt too long[^<]*<\/meta>\nk$/)
})

test('a prompt after a paused turn says it was paused, and by whom', () => {
	let byUser = prompts(replay.toMessages([say('go'), block({ type: 'text', text: 'hal' }), end('paused'), say('stop that')]))
	expect(byUser).toHaveLength(2)
	expect(byUser[1]).toMatch(/^\[\d\d:\d\d\]\n<meta>[^<]*user paused[^<]*<\/meta>\nstop that$/)
	let byHal = prompts(replay.toMessages([say('go'), end('paused', { pauseReason: 'kept crashing' }), say('why?')]))
	expect(byHal).toHaveLength(2)
	expect(byHal[1]).toMatch(/<meta>[^<]*paused[^<]*kept crashing[^<]*<\/meta>\nwhy\?$/)
	expect(byHal[1]).not.toMatch(/user paused/)
})

test('a note is for the next prompt only, and a continued turn needs none', () => {
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
	expect(texts.filter((t) => t.includes('<meta>'))).toHaveLength(2)
	expect(texts[1]).toContain('boom')
	expect(texts.at(-1)).not.toContain('<meta>')
})

test('partial text of a cancelled turn is kept; unsigned thinking is not replayed', () => {
	let msgs = replay.toMessages([
		say('hi'),
		block({ type: 'thinking', text: 'half a thou' }),
		end('cancelled'),
		say('go on'),
		block({ type: 'thinking', text: 'x' }),
		block({ type: 'text', text: 'partial ans' }),
		end('cancelled'),
	])
	expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant'])
	expect(msgs[2]!.blocks).toEqual([{ type: 'text', text: 'partial ans' }])
})

test('tool calls get their results; unanswered ones get an error result before the next prompt', () => {
	let msgs = replay.toMessages([
		say('run'),
		block(call('a')),
		block(call('b')),
		end('completed'),
		user({ type: 'tool_result', id: 'a', output: 'ok' }),
		block(call('c')),
		end('cancelled'),
		say('never mind'),
	])
	expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'user'])
	let [, , results1, , results2, next] = msgs
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
	expect(prompts(msgs)).toHaveLength(2)
})

test('a turn continued after a host went away tells the model, and cut-off calls may have run', () => {
	let msgs = replay.toMessages([say('go'), block({ type: 'text', text: 'half' }), block(call('a')), cont, block({ type: 'text', text: 'rest' })])
	expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
	let [result, note] = msgs[2]!.blocks
	expect(result).toMatchObject({ type: 'tool_result', id: 'a', isError: true })
	expect((result as any).output).toMatch(/may or may not have run/)
	expect(note).toEqual({ type: 'text', text: replay.continueNote })
})

test('continuing a paused turn after tool results asks nothing extra', () => {
	let msgs = replay.toMessages([say('go'), block(call('a')), user({ type: 'tool_result', id: 'a', output: 'ok' }), end('paused'), cont])
	expect(msgs.at(-1)).toEqual({ role: 'user', blocks: [{ type: 'tool_result', id: 'a', output: 'ok' }] })
})

test('a paused cut-off answer continues with the note; a failed request retries as it was', () => {
	let paused = replay.toMessages([say('go'), block({ type: 'text', text: 'half' }), end('paused'), cont])
	expect(paused.at(-1)!.blocks).toEqual([{ type: 'text', text: replay.continueNote }])
	let failed = replay.toMessages([say('go'), end('error'), cont])
	expect(failed).toEqual(replay.toMessages([say('go')]))
})

test('waiting inbox messages are not sent; once delivered they are one prompt, oldest first', () => {
	let waiting: HistoryRecord[] = [say('go'), block({ type: 'text', text: 'working' }), { type: 'inbox', id: 'a', text: 'one', ts }, { type: 'inbox', id: 'b', text: 'two', queue: true, ts }]
	let before = replay.toMessages(waiting)
	expect(prompts(before)).toHaveLength(1)
	let after = replay.toMessages([...waiting, { type: 'user', blocks: [{ type: 'text', text: 'one' }, { type: 'text', text: 'three' }], inbox: ['a'], ts }])
	expect(after.slice(0, before.length)).toEqual(before)
	// One text block: providers join blocks with no separator.
	expect(after.at(-1)!.blocks).toEqual([{ type: 'text', text: `[${hhmm(ts)}]\none\n\nthree` }])
})
