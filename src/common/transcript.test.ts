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
const prompt = (text: string) => ({ type: 'user' as const, blocks: [{ type: 'text' as const, text }], ts })
const said = (block: AssistantBlock) => ({ type: 'assistant' as const, block, ts })

function snap(snapshot: Omit<Snapshot, 'meta' | 'state'>): Event {
	return { type: 'snapshot', sessionId, snapshot: { meta, state: { type: 'idle' }, ...snapshot } }
}

test('a snapshot shows history as display items without provider details', () => {
	let t = fold([
		snap({
			history: [
				prompt('hi'),
				said({ type: 'thinking', text: 'hmm', signature: 'sig', provider: 'fake' }),
				said({ type: 'thinking', text: '', signature: 'redacted', provider: 'fake' }),
				said({ type: 'text', text: 'hello' }),
				said({ type: 'tool_call', id: 't1', name: 'bash', input: { cmd: 'ls' } }),
				{ type: 'turn_end', status: 'completed', reason: 'end', usage: { input: 3 }, ts },
				{ type: 'user', blocks: [{ type: 'tool_result', id: 't1', output: 'x' }], ts },
				{ type: 'turn_end', status: 'interrupted', usage: {}, ts },
			],
		}),
	])!
	expect(t.meta).toEqual(meta)
	expect(t.items).toEqual([
		{ type: 'prompt', text: 'hi' },
		{ type: 'thinking', text: 'hmm' },
		{ type: 'text', text: 'hello' },
		{ type: 'tool', id: 't1', name: 'bash', input: { cmd: 'ls' } },
		{ type: 'turn-end', status: 'completed', usage: { input: 3 } },
		{ type: 'tool-result', id: 't1', output: 'x' },
		{ type: 'turn-end', status: 'interrupted' },
	])
	expect(t.live).toBeUndefined()
})

test('streamed deltas merge into the running turn and turn-end settles it', () => {
	let t = fold([
		snap({ history: [] }),
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake' },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'a' } },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'b' } },
		{ type: 'stream', sessionId, event: { type: 'signature', value: 's' } },
		{ type: 'stream', sessionId, event: { type: 'thinking', text: 'c' } },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'x' } },
		{ type: 'stream', sessionId, event: { type: 'usage', usage: { output: 4 } } },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'y' } },
	])!
	expect(t.items).toEqual([
		{ type: 'prompt', text: 'go' },
		{ type: 'thinking', text: 'ab' },
		{ type: 'thinking', text: 'c' },
		{ type: 'text', text: 'xy' },
	])
	expect(t.live).toMatchObject({ start: 1, turn: { usage: { output: 4 } } })

	let done = fold([{ type: 'turn-end', sessionId, status: 'completed', usage: { output: 4 } }], t)!
	expect(done.items.slice(1)).toEqual([
		{ type: 'thinking', text: 'ab' },
		{ type: 'thinking', text: 'c' },
		{ type: 'text', text: 'xy' },
		{ type: 'turn-end', status: 'completed', usage: { output: 4 } },
	])
	expect(done.live).toBeUndefined()
})

test('folding never mutates the previous transcript', () => {
	let before = fold([
		snap({ history: [prompt('go')], turn: { provider: 'fake', blocks: [{ type: 'text', text: 'a' }], usage: {} } }),
	])!
	let copy = structuredClone(before)
	fold(
		[
			{ type: 'stream', sessionId, event: { type: 'text', text: 'b' } },
			{ type: 'stream', sessionId, event: { type: 'usage', usage: { input: 1 } } },
			{ type: 'turn-end', sessionId, status: 'completed' },
		],
		before,
	)
	expect(before).toEqual(copy)
})

test('events for other sessions, rejections and events before a snapshot change nothing', () => {
	expect(fold([{ type: 'turn-start', sessionId, prompt: 'x', provider: 'p' }])).toBeUndefined()
	let t = fold([snap({ history: [prompt('a')] })])!
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
		snap({ history: [prompt('fresh')] }),
	])!
	expect(t.items).toEqual([{ type: 'prompt', text: 'fresh' }])
	expect(t.live).toBeUndefined()
})

test('tool results settle the round so far; the next round streams after them', () => {
	let call = { type: 'tool_call' as const, id: 't1', name: 'read', input: { path: 'a' } }
	let events: Event[] = [
		snap({ history: [] }),
		{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake' },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'look' } },
		{ type: 'stream', sessionId, event: call },
		{ type: 'tool-results', sessionId, results: [{ type: 'tool_result', id: 't1', output: 'no such file', isError: true }] },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'gone' } },
	]
	let t = fold(events)!
	expect(t.items).toEqual([
		{ type: 'prompt', text: 'go' },
		{ type: 'text', text: 'look' },
		{ type: 'tool', id: 't1', name: 'read', input: { path: 'a' } },
		{ type: 'tool-result', id: 't1', output: 'no such file', isError: true },
		{ type: 'text', text: 'gone' },
	])
	// A client that connects now sees the same.
	let late = fold([
		snap({
			history: [
				prompt('go'),
				said({ type: 'text', text: 'look' }),
				said(call),
				{ type: 'user', blocks: [{ type: 'tool_result', id: 't1', output: 'no such file', isError: true }], ts },
			],
			turn: { provider: 'fake', blocks: [{ type: 'text', text: 'gone' }], usage: {} },
		}),
	])!
	expect(late).toEqual(t)
	let end: Event = { type: 'turn-end', sessionId, status: 'completed' }
	expect(fold([end], late)).toEqual(fold([end], t)!)
})

test('state events and a continued turn fold like the snapshot that follows them', () => {
	let running = { type: 'running' as const, phase: 'streaming' as const }
	let t = fold([
		snap({ history: [prompt('go'), said({ type: 'text', text: 'a' }), { type: 'turn_end', status: 'paused', usage: {}, ts }] }),
		{ type: 'state', sessionId, state: running },
		{ type: 'turn-start', sessionId, provider: 'fake' },
		{ type: 'stream', sessionId, event: { type: 'text', text: 'b' } },
	])!
	expect(t.state).toEqual(running)
	let later = fold([
		snap({
			history: [prompt('go'), said({ type: 'text', text: 'a' }), { type: 'turn_end', status: 'paused', usage: {}, ts }, { type: 'continue', ts }],
			turn: { provider: 'fake', blocks: [{ type: 'text', text: 'b' }], usage: {} },
		}),
		{ type: 'state', sessionId, state: running },
	])!
	expect(later).toEqual(t)
})

test('a snapshot marks where replayed history ends and when it was last written', () => {
	let history = [prompt('old'), said({ type: 'text', text: 'answer' }), { type: 'turn_end' as const, status: 'error' as const, error: 'boom', usage: {}, ts: '2026-09-26T00:51:00Z' }]
	let event = snap({ history, turn: { provider: 'fake', blocks: [{ type: 'text', text: 'new' }], usage: {} } }) as Extract<Event, { type: 'snapshot' }>
	let t = fold([event])!
	let r = transcript.resumed(event.snapshot, t)!
	// The running turn's output comes after the mark, the old error before it.
	expect(t.items.slice(0, r.at).at(-1)).toMatchObject({ type: 'turn-end', status: 'error' })
	expect(t.items.slice(r.at)).toEqual([{ type: 'text', text: 'new' }])
	expect(r.last).toBe('2026-09-26T00:51:00Z')
	let empty = snap({ history: [] }) as Extract<Event, { type: 'snapshot' }>
	expect(transcript.resumed(empty.snapshot, fold([empty])!)).toBeUndefined()
})

test('the resumed mark names the last turn time, and its date when not today', () => {
	let last = new Date(2026, 8, 26, 0, 51).toISOString()
	expect(transcript.resumedLabel({ at: 0, last }, new Date(2026, 8, 26, 9, 0))).toBe('resumed · last turn 00:51')
	expect(transcript.resumedLabel({ at: 0, last }, new Date(2026, 8, 27, 0, 10))).toBe('resumed · last turn 2026-09-26 00:51')
})
