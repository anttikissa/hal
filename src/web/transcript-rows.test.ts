// Transcript rows: tool calls paired with results, stable row identity
// and pending prompts (transcript-rows.ts).

import { expect, test } from 'bun:test'
import type { Event } from '../common/protocol.ts'
import { view } from './view.ts'
import { transcriptRows } from './transcript-rows.ts'
import { fold, meta, running, sessionId, useNames } from './view-fixture.test.ts'

useNames()

test('rows pair each tool call with its result and drop completed turn ends', () => {
	let st = running(
		[
			{ type: 'stream', sessionId, event: { type: 'tool_call', id: 'a', name: 'bash', input: {} } },
			{ type: 'stream', sessionId, event: { type: 'tool_call', id: 'b', name: 'read', input: {} } },
			{
				type: 'tool-results',
				sessionId,
				results: [
					{ type: 'tool_result', id: 'b', output: 'B' },
					{ type: 'tool_result', id: 'a', output: 'A' },
				],
			},
			{ type: 'stream', sessionId, event: { type: 'text', text: 'done' } },
			{ type: 'turn-end', sessionId, status: 'completed' },
		] as Event[],
		{ type: 'idle' },
	)
	let rows = transcriptRows.rows(st.transcript!.items)
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
	let all = transcriptRows.rows(items)
	for (let k = 0; k <= items.length; k++) {
		let some = transcriptRows.rows(items.slice(0, k))
		expect(some.map((r) => r.item)).toEqual(all.slice(0, some.length).map((r) => r.item))
	}
})

test('streaming updates only its row; results replace their call row without mutating it', () => {
	let st = running(
		[
			{ type: 'stream', sessionId, event: { type: 'tool_call', id: 'a', name: 'bash', input: {} } },
			{ type: 'stream', sessionId, event: { type: 'text', text: 'one' } },
		] as Event[],
		{ type: 'idle' },
	)
	let before = transcriptRows.rows(st.transcript!.items)
	st = view.onEvent(st, { type: 'stream', sessionId, event: { type: 'text', text: ' two' } })
	let streamed = transcriptRows.rows(st.transcript!.items, st.sent, before)
	expect(streamed[0]).toBe(before[0])
	expect(streamed[1]).toBe(before[1])
	expect(streamed.at(-1)).not.toBe(before.at(-1))
	expect(transcriptRows.rows(st.transcript!.items, st.sent, streamed)).toBe(streamed)
	st = view.onEvent(st, {
		type: 'tool-results',
		sessionId,
		results: [{ type: 'tool_result', id: 'a', output: 'done' }],
	})
	let completed = transcriptRows.rows(st.transcript!.items, st.sent, streamed)
	expect(completed[1]).not.toBe(streamed[1])
	expect(completed[1]!.result?.output).toBe('done')
	expect(streamed[1]!.result).toBeUndefined()
	expect(completed.at(-1)).toBe(streamed.at(-1))
})

test('a sent prompt shows pending, then as the host’s item under the same key, once', () => {
	let st = fold([{ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } }] as Event[])
	let sending = [{ id: 'c7', text: 'go' }]
	let before = transcriptRows.withPending(transcriptRows.rows(st.transcript!.items, st.sent), sending)
	expect(before.map((r) => [r.key, r.item.type, r.pending])).toEqual([['c7', 'prompt', true]])
	// The durable inbox replaces the optimistic row before acknowledgement,
	// using the same key; it lives in the transcript, not the fixed footer.
	let waiting = [{ id: 'c7', text: 'go', delivery: 'after-turn' as const }]
	let queued = transcriptRows.withPending(transcriptRows.rows(st.transcript!.items, st.sent), sending, waiting)
	expect(queued.map((r) => [r.key, r.pending, r.waiting])).toEqual([['c7', undefined, true]])
	expect(queued[0]!.item).toMatchObject({ delivery: 'after-turn' })
	let steering = transcriptRows.withPending([], sending, [{ id: 'c7', text: 'go' }])
	expect(steering).toHaveLength(1)
	expect(steering[0]!.item).toMatchObject({ type: 'prompt', text: 'go', delivery: 'now' })
	// The host's item arrives before the ack that ends the pending one.
	st = fold([{ type: 'turn-start', sessionId, prompt: 'go', provider: 'fake', n: 4, command: 'c7' }] as Event[], st)
	let after = transcriptRows.withPending(transcriptRows.rows(st.transcript!.items, st.sent), sending)
	expect(after.map((r) => [r.key, r.item.type, r.pending])).toEqual([['c7', 'prompt', undefined]])
})
