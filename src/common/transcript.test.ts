import { expect, test } from 'bun:test'
import type { AssistantBlock } from './blocks.ts'
import type { Event, Snapshot } from './protocol.ts'
import { transcript, type Transcript } from './transcript.ts'

const meta = { id: '1-abc', cwd: '/w', model: 'fake/m', createdAt: '2026-09-26T00:00:00Z' }
const sessionId = meta.id

function fold(events: Event[], start?: Transcript): Transcript | undefined {
	return events.reduce<Transcript | undefined>((t, e) => transcript.fold(t, e), start)
}

const ts = '2026-09-26T00:00:01Z'
// Records numbered as the host numbers them (HistoryRecord `n`).
const prompt = (text: string, n: number) => ({ type: 'user' as const, blocks: [{ type: 'text' as const, text }], ts, n })
const said = (block: AssistantBlock, n: number) => ({ type: 'assistant' as const, block, ts, n })

function snap(snapshot: Omit<Snapshot, 'meta' | 'state'>): Event {
	return { type: 'snapshot', sessionId, snapshot: { meta, state: { type: 'idle' }, ...snapshot } }
}

test('a snapshot shows history as display items without provider details', () => {
	let t = fold([
		snap({
			history: [
				prompt('hi', 1),
				said({ type: 'thinking', text: 'hmm', signature: 'sig', provider: 'fake' }, 2),
				said({ type: 'thinking', text: '', signature: 'redacted', provider: 'fake' }, 3),
				said({ type: 'text', text: 'hello' }, 4),
				said({ type: 'tool_call', id: 't1', name: 'bash', input: { cmd: 'ls' } }, 5),
				{ type: 'turn_end', status: 'completed', reason: 'end', usage: { input: 3 }, ts, n: 6 },
				{ type: 'user', blocks: [{ type: 'tool_result', id: 't1', output: 'x' }, { type: 'tool_result', id: 't2', output: 'y' }], ts, n: 7 },
				{ type: 'turn_end', status: 'interrupted', usage: {}, ts },
			],
		}),
	])!
	expect(t.meta).toEqual(meta)
	expect(t.items).toEqual([
		{ type: 'prompt', text: 'hi', key: '1' },
		{ type: 'thinking', text: 'hmm', key: '2' },
		{ type: 'text', text: 'hello', key: '4' },
		{ type: 'tool', id: 't1', name: 'bash', input: { cmd: 'ls' }, key: '5' },
		{ type: 'turn-end', status: 'completed', usage: { input: 3 }, key: '6' },
		// One record, two items; a record built without a number is keyed
		// by its place.
		{ type: 'tool-result', id: 't1', output: 'x', key: '7' },
		{ type: 'tool-result', id: 't2', output: 'y', key: '7.1' },
		{ type: 'turn-end', status: 'interrupted', key: '~7' },
	])
	expect(t.live).toBeUndefined()
})

test('streamed deltas merge into the running turn and turn-end settles it', () => {
	let t = fold([
		snap({ history: [] }),
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake', n: 1 },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'a' }, n: 2 },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'b' }, n: 2 },
		{ type: 'stream', sessionId, event: { type: 'signature', value: 's' }, n: 2 },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'c' }, n: 3 },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'x' }, n: 4 },
		{ type: 'stream', sessionId, event: { type: 'usage', usage: { output: 4 } }, n: 4 },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'y' }, n: 4 },
	])!
	// Each item has its record's number from its first streamed byte.
	expect(t.items).toEqual([
		{ type: 'prompt', text: 'go', key: '1' },
		{ type: 'thinking', text: 'ab', key: '2' },
		{ type: 'thinking', text: 'c', key: '3' },
		{ type: 'text', text: 'xy', key: '4' },
	])
	expect(t.live).toMatchObject({ start: 1, turn: { usage: { output: 4 } } })

	let done = fold([{ type: 'turn-end', sessionId, status: 'completed', usage: { output: 4 }, n: 5 }], t)!
	expect(done.items.slice(1)).toEqual([
		{ type: 'thinking', text: 'ab', key: '2' },
		{ type: 'thinking', text: 'c', key: '3' },
		{ type: 'text', text: 'xy', key: '4' },
		{ type: 'turn-end', status: 'completed', usage: { output: 4 }, key: '5' },
	])
	expect(done.live).toBeUndefined()
})

test('folding never mutates the previous transcript', () => {
	let before = fold([
		snap({ history: [prompt('go', 1)], turn: { provider: 'fake', blocks: [{ type: 'text', text: 'a' }], usage: {}, ns: [2] } }),
	])!
	let copy = structuredClone(before)
	fold(
		[
			{ type: 'stream', sessionId, event: { type: 'text', text: 'b' }, n: 2 },
			{ type: 'stream', sessionId, event: { type: 'text', text: 'c' }, n: 3 },
			{ type: 'stream', sessionId, event: { type: 'usage', usage: { input: 1 } } },
			{ type: 'turn-end', sessionId, status: 'completed' },
		],
		before,
	)
	expect(before).toEqual(copy)
})

test('events for other sessions, rejections and events before a snapshot change nothing', () => {
	expect(fold([{ type: 'turn-start', sessionId, prompt: 'x', provider: 'p' }])).toBeUndefined()
	let t = fold([snap({ history: [prompt('a', 1)] })])!
	for (let e of [
		{ type: 'turn-start', sessionId: 'other', prompt: 'x', provider: 'p' },
		{ type: 'rejected', sessionId, command: 'submit', reason: 'busy' },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'stray' } },
	] as Event[])
		expect(transcript.fold(t, e)).toBe(t)
})

test('a later snapshot replaces whatever was folded before', () => {
	let t = fold([
		snap({ history: [] }),
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake' },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'x' } },
		snap({ history: [prompt('fresh', 1)] }),
	])!
	expect(t.items).toEqual([{ type: 'prompt', text: 'fresh', key: '1' }])
	expect(t.live).toBeUndefined()
})

test('tool results settle the round so far; the next round streams after them', () => {
	let call = { type: 'tool_call' as const, id: 't1', name: 'read', input: { path: 'a' } }
	let events: Event[] = [
		snap({ history: [] }),
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake', n: 1 },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'look' }, n: 2 },
		{ type: 'stream', sessionId, event: call, n: 3 },
		{ type: 'tool-results', sessionId, results: [{ type: 'tool_result', id: 't1', output: 'no such file', isError: true }], n: 4 },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'gone' }, n: 5 },
	]
	let t = fold(events)!
	expect(t.items).toEqual([
		{ type: 'prompt', text: 'go', key: '1' },
		{ type: 'text', text: 'look', key: '2' },
		{ type: 'tool', id: 't1', name: 'read', input: { path: 'a' }, key: '3' },
		{ type: 'tool-result', id: 't1', output: 'no such file', isError: true, key: '4' },
		{ type: 'text', text: 'gone', key: '5' },
	])
	// A client that connects now sees the same.
	let late = fold([
		snap({
			history: [
				prompt('go', 1),
				said({ type: 'text', text: 'look' }, 2),
				said(call, 3),
				{ type: 'user', blocks: [{ type: 'tool_result', id: 't1', output: 'no such file', isError: true }], ts, n: 4 },
			],
			turn: { provider: 'fake', blocks: [{ type: 'text', text: 'gone' }], usage: {}, ns: [5] },
		}),
	])!
	expect(late).toEqual(t)
	let end: Event = { type: 'turn-end', sessionId, status: 'completed', n: 6 }
	expect(fold([end], late)).toEqual(fold([end], t)!)
})

test('state events and a continued turn fold like the snapshot that follows them', () => {
	let running = { type: 'running' as const, phase: 'streaming' as const }
	let t = fold([
		snap({ history: [prompt('go', 1), said({ type: 'text', text: 'a' }, 2), { type: 'turn_end', status: 'paused', usage: {}, ts, n: 3 }] }),
		{ type: 'state', sessionId, state: running },
		{ type: 'turn-start', sessionId, provider: 'fake' },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'b' }, n: 5 },
	])!
	expect(t.state).toEqual(running)
	let later = fold([
		snap({
			history: [prompt('go', 1), said({ type: 'text', text: 'a' }, 2), { type: 'turn_end', status: 'paused', usage: {}, ts, n: 3 }, { type: 'continue', ts, n: 4 }],
			turn: { provider: 'fake', blocks: [{ type: 'text', text: 'b' }], usage: {}, ns: [5] },
		}),
		{ type: 'state', sessionId, state: running },
	])!
	expect(later).toEqual(t)
})

test('a snapshot marks where replayed history ends and when it was last written', () => {
	let history = [prompt('old', 1), said({ type: 'text', text: 'answer' }, 2), { type: 'turn_end' as const, status: 'error' as const, error: 'boom', usage: {}, ts: '2026-09-26T00:51:00Z', n: 3 }]
	let event = snap({ history, turn: { provider: 'fake', blocks: [{ type: 'text', text: 'new' }], usage: {}, ns: [4] } }) as Extract<Event, { type: 'snapshot' }>
	let t = fold([event])!
	let r = transcript.resumed(event.snapshot, t)!
	// The running turn's output comes after the mark, the old error before it.
	expect(t.items.slice(0, r.at).at(-1)).toMatchObject({ type: 'turn-end', status: 'error' })
	expect(t.items.slice(r.at)).toEqual([{ type: 'text', text: 'new', key: '4' }])
	expect(r.last).toBe('2026-09-26T00:51:00Z')
	let empty = snap({ history: [] }) as Extract<Event, { type: 'snapshot' }>
	expect(transcript.resumed(empty.snapshot, fold([empty])!)).toBeUndefined()
})

test('the resumed mark names the last turn time, and its date when not today', () => {
	let last = new Date(2026, 8, 26, 0, 51).toISOString()
	expect(transcript.resumedLabel({ at: 0, last }, new Date(2026, 8, 26, 9, 0))).toBe('resumed · last turn 00:51')
	expect(transcript.resumedLabel({ at: 0, last }, new Date(2026, 8, 27, 0, 10))).toBe('resumed · last turn 2026-09-26 00:51')
})

test('a question and its answer fold like the snapshot that follows them, and only the waiting one is open', () => {
	let form = { text: 'Name?', fields: [{ type: 'secret' as const, name: 'key' }] }
	let asking = { type: 'blocked' as const, reason: 'question' }
	let live = fold([
		snap({ history: [prompt('hi', 1)], turn: { provider: 'hal', blocks: [], usage: {}, ns: [] } }),
		{ type: 'stream', sessionId, event: { type: 'text', text: 'Hello.' }, n: 2 },
		{ type: 'question', sessionId, id: 'q1', form, n: 3 },
		{ type: 'state', sessionId, state: asking },
	])!
	let stored = fold([snap({ history: [prompt('hi', 1), said({ type: 'text', text: 'Hello.' }, 2), { type: 'question', id: 'q1', form, ts, n: 3 }] }), { type: 'state', sessionId, state: asking }])!
	expect(live).toEqual(stored)
	expect(live.live).toBeUndefined()
	expect(transcript.question(live)?.id).toBe('q1')
	let answered = fold([{ type: 'answer', sessionId, question: 'q1', answers: {}, secrets: ['key'] }, { type: 'state', sessionId, state: { type: 'idle' } }], live)!
	expect(answered.items.at(-1)).toEqual({ type: 'question', id: 'q1', form, answers: {}, secrets: ['key'], key: '3' })
	expect(transcript.question(answered)).toBeUndefined()
	let later = fold([
		snap({ history: [prompt('hi', 1), said({ type: 'text', text: 'Hello.' }, 2), { type: 'question', id: 'q1', form, ts, n: 3 }, { type: 'answer', question: 'q1', answers: {}, secrets: ['key'], ts, n: 4 }] }),
	])!
	expect(later.items).toEqual(answered.items)
	// A question left by a pause is not open.
	expect(transcript.question({ ...live, state: { type: 'paused' } })).toBeUndefined()
})

test('an edited prompt takes the place of the prompt it replaces and its turn, live as on reconnect', () => {
	let paused = (n: number) => ({ type: 'turn_end' as const, status: 'paused' as const, usage: {}, ts, n })
	let before = [prompt('hi', 1), said({ type: 'text', text: 'hello' }, 2), { type: 'turn_end' as const, status: 'completed' as const, usage: {}, ts, n: 3 }]
	// A prompt that delivered a steering message ('one') with the typed one.
	let two = { type: 'user' as const, blocks: [{ type: 'text' as const, text: 'one' }, { type: 'text' as const, text: 'fix ti' }], ts, n: 4 }
	let history = [...before, two, said({ type: 'text', text: 'Looking' }, 5), paused(6)]
	let t = fold([
		snap({ history }),
		{ type: 'prompt', sessionId, texts: ['one', 'fix it'], replaces: true, n: 7 },
		{ type: 'turn-start', sessionId, provider: 'fake' },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'Fixed' }, n: 8 },
	])!
	expect(t.items.slice(before.length)).toEqual([
		{ type: 'prompt', text: 'one', key: '7' },
		{ type: 'prompt', text: 'fix it', key: '7.1' },
		{ type: 'text', text: 'Fixed', key: '8' },
	])
	let edited = { type: 'user' as const, blocks: [{ type: 'text' as const, text: 'one' }, { type: 'text' as const, text: 'fix it' }], replaces: true as const, ts, n: 7 }
	let late = fold([snap({ history: [...history, edited], turn: { provider: 'fake', blocks: [{ type: 'text', text: 'Fixed' }], usage: {}, ns: [8] } })])!
	expect(late).toEqual(t)
	// Edited again: the edit is now the prompt it replaces.
	let again: Event = { type: 'prompt', sessionId, texts: ['fix it!'], replaces: true, n: 10 }
	let end: Event = { type: 'turn-end', sessionId, status: 'paused', n: 9 }
	let t2 = fold([end, again], t)!
	expect(t2.items.slice(before.length)).toEqual([{ type: 'prompt', text: 'fix it!', key: '10' }])
	let late2 = fold([snap({ history: [...history, edited, said({ type: 'text', text: 'Fixed' }, 8), paused(9), { ...edited, blocks: [{ type: 'text', text: 'fix it!' }], n: 10 }] })])!
	expect(late2).toEqual(t2)
})

test('a command during a running turn goes where history has it: after finished blocks, before the one streaming', () => {
	let t = fold([
		snap({ history: [] }),
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake', n: 1 },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'hm' }, n: 2 },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'wor' }, n: 3 },
		{ type: 'command', sessionId, text: '/cd x', from: '2-xyz', n: 4, streaming: true },
		{ type: 'output', sessionId, text: 'no such directory', error: true, n: 5, streaming: true },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'king' }, n: 3 },
		{ type: 'stream', sessionId, event: { type: 'tool_call', id: 'c', name: 'ls', input: {} }, n: 6 },
		// The round is done: every block is in history before this one.
		{ type: 'command', sessionId, text: '/help', n: 7 },
		{ type: 'meta', sessionId, meta: { ...meta, cwd: '/x' } },
		{ type: 'tool-results', sessionId, results: [{ type: 'tool_result', id: 'c', output: 'ok' }], n: 8 },
		{ type: 'turn-end', sessionId, status: 'completed', n: 9 },
	])!
	// The streaming block keeps the number it started with, written
	// after the command numbered past it.
	expect(t.items).toEqual([
		{ type: 'prompt', text: 'go', key: '1' },
		{ type: 'thinking', text: 'hm', key: '2' },
		{ type: 'command', text: '/cd x', from: '2-xyz', key: '4' },
		{ type: 'output', text: 'no such directory', error: true, key: '5' },
		{ type: 'text', text: 'working', key: '3' },
		{ type: 'tool', id: 'c', name: 'ls', input: {}, key: '6' },
		{ type: 'command', text: '/help', key: '7' },
		{ type: 'tool-result', id: 'c', output: 'ok', key: '8' },
		{ type: 'turn-end', status: 'completed', key: '9' },
	])
	let late = fold([
		snap({
			history: [
				prompt('go', 1),
				said({ type: 'thinking', text: 'hm' }, 2),
				{ type: 'command', text: '/cd x', from: '2-xyz', ts, n: 4 },
				{ type: 'output', text: 'no such directory', error: true, ts, n: 5 },
				said({ type: 'text', text: 'working' }, 3),
				said({ type: 'tool_call', id: 'c', name: 'ls', input: {} }, 6),
				{ type: 'command', text: '/help', ts, n: 7 },
				{ type: 'user', blocks: [{ type: 'tool_result', id: 'c', output: 'ok' }], ts, n: 8 },
				{ type: 'turn_end', status: 'completed', usage: {}, ts, n: 9 },
			],
		}),
	])!
	expect(late.items).toEqual(t.items)
	expect(t.meta.cwd).toBe('/x')
})
