import { expect, test } from 'bun:test'
import type { AssistantBlock } from './blocks.ts'
import type { Event, Snapshot } from './protocol.ts'
import { transcript, type Transcript } from './transcript.ts'
import { titles } from './titles.ts'

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
		{ type: 'prompt', text: 'hi', ts, key: '1' },
		{ type: 'thinking', text: 'hmm', ts, key: '2' },
		{ type: 'text', text: 'hello', ts, key: '4' },
		{ type: 'tool', id: 't1', name: 'bash', input: { cmd: 'ls' }, key: '5', ts },
		{ type: 'turn-end', status: 'completed', usage: { input: 3 }, ts, key: '6' },
		// One record, two items; a record built without a number is keyed
		// by its place.
		{ type: 'tool-result', id: 't1', output: 'x', ts, key: '7' },
		{ type: 'tool-result', id: 't2', output: 'y', ts, key: '7.1' },
		{ type: 'turn-end', status: 'interrupted', ts, key: '~7' },
	])
	expect(t.live).toBeUndefined()
})

test('streamed deltas merge into the running turn and turn-end settles it', () => {
	let t = fold([
		snap({ history: [] }),
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake', n: 1, ts },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'a' }, n: 2, ts },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'b' }, n: 2, ts },
		{ type: 'stream', sessionId, event: { type: 'signature', value: 's' }, n: 2, ts },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'c' }, n: 3, ts },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'x' }, n: 4, ts },
		{ type: 'stream', sessionId, event: { type: 'usage', usage: { output: 4 } }, n: 4, ts },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'y' }, n: 4, ts },
	])!
	// Each item has its record's number from its first streamed byte.
	expect(t.items).toEqual([
		{ type: 'prompt', text: 'go', ts, key: '1' },
		{ type: 'thinking', text: 'ab', ts, key: '2' },
		{ type: 'thinking', text: 'c', ts, key: '3' },
		{ type: 'text', text: 'xy', ts, key: '4' },
	])
	expect(t.live).toMatchObject({ start: 1, turn: { usage: { output: 4 } } })

	let done = fold([{ type: 'turn-end', sessionId, status: 'completed', usage: { output: 4 }, n: 5 }], t)!
	expect(done.items.slice(1)).toEqual([
		{ type: 'thinking', text: 'ab', ts, key: '2' },
		{ type: 'thinking', text: 'c', ts, key: '3' },
		{ type: 'text', text: 'xy', ts, key: '4' },
		{ type: 'turn-end', status: 'completed', usage: { output: 4 }, key: '5' },
	])
	expect(done.live).toBeUndefined()
})

test('folding never mutates the previous transcript', () => {
	let before = fold([
		snap({ history: [prompt('go', 1)], turn: { provider: 'fake', blocks: [{ type: 'text', text: 'a' }], usage: {}, ns: [2], ts: [ts] } }),
	])!
	let copy = structuredClone(before)
	fold(
		[
			{ type: 'stream', sessionId, event: { type: 'text', text: 'b' }, n: 2, ts },
			{ type: 'stream', sessionId, event: { type: 'text', text: 'c' }, n: 3, ts },
			{ type: 'stream', sessionId, event: { type: 'usage', usage: { input: 1 } }, ts },
			{ type: 'turn-end', sessionId, status: 'completed' },
		],
		before,
	)
	expect(before).toEqual(copy)
})

test('events for other sessions, rejections and events before a snapshot change nothing', () => {
	expect(fold([{ type: 'turn-start', sessionId, prompt: 'x', provider: 'p', ts }])).toBeUndefined()
	let t = fold([snap({ history: [prompt('a', 1)] })])!
	for (let e of [
		{ type: 'turn-start', sessionId: 'other', prompt: 'x', provider: 'p' },
		{ type: 'rejected', sessionId, command: 'submit', reason: 'busy' },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'stray' }, ts },
	] as Event[])
		expect(transcript.fold(t, e)).toBe(t)
})

test('a later snapshot replaces whatever was folded before', () => {
	let t = fold([
		snap({ history: [] }),
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake', ts },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'x' }, ts },
		snap({ history: [prompt('fresh', 1)] }),
	])!
	expect(t.items).toEqual([{ type: 'prompt', text: 'fresh', ts, key: '1' }])
	expect(t.live).toBeUndefined()
})

test('tool results settle the round so far; the next round streams after them', () => {
	let call = { type: 'tool_call' as const, id: 't1', name: 'read', input: { path: 'a' } }
	let events: Event[] = [
		snap({ history: [] }),
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake', n: 1, ts },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'look' }, n: 2, ts },
		{ type: 'stream', sessionId, event: call, n: 3, ts },
		{ type: 'tool-results', sessionId, results: [{ type: 'tool_result', id: 't1', output: 'no such file', isError: true }], n: 4, ts },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'gone' }, n: 5, ts },
	]
	let t = fold(events)!
	expect(t.items).toEqual([
		{ type: 'prompt', text: 'go', ts, key: '1' },
		{ type: 'text', text: 'look', ts, key: '2' },
		{ type: 'tool', id: 't1', name: 'read', input: { path: 'a' }, key: '3', ts },
		{ type: 'tool-result', id: 't1', output: 'no such file', isError: true, ts, key: '4' },
		{ type: 'text', text: 'gone', ts, key: '5' },
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
			turn: { provider: 'fake', blocks: [{ type: 'text', text: 'gone' }], usage: {}, ns: [5], ts: [ts] },
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
		{ type: 'stream', sessionId, event: { type: 'text', text: 'b' }, n: 5, ts },
	])!
	expect(t.state).toEqual(running)
	let later = fold([
		snap({
			history: [prompt('go', 1), said({ type: 'text', text: 'a' }, 2), { type: 'turn_end', status: 'paused', usage: {}, ts, n: 3 }, { type: 'continue', ts, n: 4 }],
			turn: { provider: 'fake', blocks: [{ type: 'text', text: 'b' }], usage: {}, ns: [5], ts: [ts] },
		}),
		{ type: 'state', sessionId, state: running },
	])!
	expect(later).toEqual(t)
})


test('a question and its answer fold like the snapshot that follows them, and only the waiting one is open', () => {
	let form = { text: 'Name?', fields: [{ type: 'secret' as const, name: 'key' }] }
	let asking = { type: 'blocked' as const, reason: 'question' }
	let live = fold([
		snap({ history: [prompt('hi', 1)], turn: { provider: 'hal', blocks: [], usage: {}, ns: [] } }),
		{ type: 'stream', sessionId, event: { type: 'text', text: 'Hello.' }, n: 2, ts },
		{ type: 'question', sessionId, id: 'q1', form, n: 3, ts },
		{ type: 'state', sessionId, state: asking },
	])!
	let stored = fold([snap({ history: [prompt('hi', 1), said({ type: 'text', text: 'Hello.' }, 2), { type: 'question', id: 'q1', form, ts, n: 3 }] }), { type: 'state', sessionId, state: asking }])!
	expect(live).toEqual(stored)
	expect(live.live).toBeUndefined()
	expect(transcript.question(live)?.id).toBe('q1')
	let answered = fold([{ type: 'answer', sessionId, question: 'q1', answers: {}, secrets: ['key'] }, { type: 'state', sessionId, state: { type: 'idle' } }], live)!
	expect(answered.items.at(-1)).toEqual({ type: 'question', id: 'q1', form, answers: {}, secrets: ['key'], key: '3', ts })
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
		{ type: 'prompt', sessionId, texts: ['one', 'fix it'], replaces: true, n: 7, ts },
		{ type: 'turn-start', sessionId, provider: 'fake' },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'Fixed' }, n: 8, ts },
	])!
	expect(t.items.slice(before.length)).toEqual([
		{ type: 'prompt', text: 'one', ts, key: '7' },
		{ type: 'prompt', text: 'fix it', ts, key: '7.1' },
		{ type: 'text', text: 'Fixed', ts, key: '8' },
	])
	let edited = { type: 'user' as const, blocks: [{ type: 'text' as const, text: 'one' }, { type: 'text' as const, text: 'fix it' }], replaces: true as const, ts, n: 7 }
	let late = fold([snap({ history: [...history, edited], turn: { provider: 'fake', blocks: [{ type: 'text', text: 'Fixed' }], usage: {}, ns: [8], ts: [ts] } })])!
	expect(late).toEqual(t)
	// Edited again: the edit is now the prompt it replaces.
	let again: Event = { type: 'prompt', sessionId, texts: ['fix it!'], replaces: true, n: 10, ts }
	let end: Event = { type: 'turn-end', sessionId, status: 'paused', n: 9 }
	let t2 = fold([end, again], t)!
	expect(t2.items.slice(before.length)).toEqual([{ type: 'prompt', text: 'fix it!', ts, key: '10' }])
	let late2 = fold([snap({ history: [...history, edited, said({ type: 'text', text: 'Fixed' }, 8), paused(9), { ...edited, blocks: [{ type: 'text', text: 'fix it!' }], n: 10 }] })])!
	expect(late2).toEqual(t2)
})

test('a command during a running turn stays after the block already streaming', () => {
	let t = fold([
		snap({ history: [] }),
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake', n: 1, ts },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'hm' }, n: 2, ts },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'wor' }, n: 3, ts },
		{ type: 'command', sessionId, text: '/cd x', from: '2-xyz', ts, n: 4, streaming: true },
		{ type: 'output', sessionId, text: 'no such directory', error: true, ts, n: 5, streaming: true },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'king' }, n: 3, ts },
		{ type: 'stream', sessionId, event: { type: 'tool_call', id: 'c', name: 'ls', input: {} }, n: 6, ts },
		// The round is done: every block is in history before this one.
		{ type: 'command', sessionId, text: '/help', ts, n: 7 },
		{ type: 'meta', sessionId, meta: { ...meta, cwd: '/x' } },
		{ type: 'tool-results', sessionId, results: [{ type: 'tool_result', id: 'c', output: 'ok' }], n: 8, ts },
		{ type: 'turn-end', sessionId, status: 'completed', n: 9, ts },
	])!
	// A block keeps its start position even though it finishes after the command.
	expect(t.items).toEqual([
		{ type: 'prompt', text: 'go', ts, key: '1' },
		{ type: 'thinking', text: 'hm', ts, key: '2' },
		{ type: 'text', text: 'working', ts, key: '3' },
		{ type: 'command', text: '/cd x', from: '2-xyz', ts, key: '4' },
		{ type: 'output', text: 'no such directory', error: true, ts, key: '5' },
		{ type: 'tool', id: 'c', name: 'ls', input: {}, key: '6', ts },
		{ type: 'command', text: '/help', ts, key: '7' },
		{ type: 'tool-result', id: 'c', output: 'ok', ts, key: '8' },
		{ type: 'turn-end', status: 'completed', ts, key: '9' },
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

test('attachment acknowledgements and picker replies cannot end a streaming turn', () => {
	let t = fold([snap({ history: [] }),
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake', n: 1, ts },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'still ' }, n: 2, ts },
	])!
	for (let event of [
		{ type: 'attached', sessionId, command: 'upload', blob: '123abc', marker: '[image/example.png]' },
		{ type: 'models', sessionId, current: 'fake/m', items: ['fake/m'] },
	] satisfies Event[]) expect(transcript.fold(t, event)).toBe(t)
	let next = transcript.fold(t, { type: 'stream', sessionId, event: { type: 'text', text: 'working' }, n: 2, ts })!
	expect(next.items.at(-1)).toMatchObject({ type: 'text', text: 'still working' })
	expect(next.live).toBeDefined()
})

test('a model-run command shows only as its tool card, live and restored; a typed one keeps its timestamps', () => {
	let model = [
		{ type: 'command' as const, text: '/rename New title', origin: 'model' as const, ts, n: 1 },
		{ type: 'output' as const, text: 'Session renamed: Old title → New title', origin: 'model' as const, ts, n: 2 },
	]
	let typed = [{ type: 'command' as const, text: '/cd /tmp', ts, n: 3 }, { type: 'output' as const, text: 'cwd: /tmp', ts, n: 4 }]
	let live = fold([snap({ history: [] }), ...[...model, ...typed].map((e) => ({ ...e, sessionId }))])!
	let restored = fold([snap({ history: [...model, ...typed] })])!
	expect(live.items).toEqual(restored.items)
	expect(restored.items).toMatchObject([{ type: 'command', text: '/cd /tmp', ts }, { type: 'output', text: 'cwd: /tmp', ts }])
})

test('waiting and delivered steering use the same header, without labeling a following fresh prompt', () => {
	let waiting = transcript.waitingItem({ id: 's1', text: 'interrupt' })
	expect(titles.title(waiting)).toBe('You (interrupted)')
	let live = fold([
		snap({ history: [] }),
		{ type: 'prompt', sessionId, texts: ['interrupt', 'fresh'], senders: [{ steering: true }, {}], n: 3 },
	])!
	let loaded = fold([snap({ history: [
		{ type: 'inbox', id: 's1', text: 'interrupt', ts, n: 1 },
		{ type: 'user', blocks: [{ type: 'text', text: 'interrupt' }, { type: 'text', text: 'fresh' }], inbox: ['s1'], ts, n: 3 },
	] })])!
	for (let t of [live, loaded]) {
		expect(t.items.map((i) => titles.who(i))).toEqual(['You (interrupted)', 'You'])
	}
})
