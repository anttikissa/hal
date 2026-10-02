import { expect, test } from 'bun:test'
import { compaction } from './compaction.ts'
import { replay, type HistoryRecord } from './replay.ts'

const ts = '2026-01-01T10:00:00.000Z'
let n = 0
const prompt = (text: string): HistoryRecord => ({ type: 'user', blocks: [{ type: 'text', text }], ts, n: ++n })
const say = (text: string): HistoryRecord => ({ type: 'assistant', block: { type: 'text', text }, ts, n: ++n })
const call = (id: string): HistoryRecord => ({ type: 'assistant', block: { type: 'tool_call', id, name: 'bash', input: {} }, ts, n: ++n })
const result = (id: string): HistoryRecord => ({ type: 'user', blocks: [{ type: 'tool_result', id, output: 'x' }], ts, n: ++n })
const end = (): HistoryRecord => ({ type: 'turn_end', status: 'completed', usage: {}, ts, n: ++n })

// A turn: the prompt, one tool call and result, the answer.
function turn(i: number): HistoryRecord[] {
	return [prompt(`p${i}`), call(`c${i}`), result(`c${i}`), say(`a${i}`), end()]
}

function session(turnsCount: number): HistoryRecord[] {
	n = 0
	return Array.from({ length: turnsCount }, (_, i) => turn(i + 1)).flat()
}

test('keeps the first prompt and answer, the last three prompts and answers, and counts the rest', () => {
	let made = compaction.summary(session(6), '/h/history.asonl')!
	expect(made.prompts).toBe(6)
	let lines = made.summary.split('\n')
	expect(lines[0]).toBe('Context was compacted to avoid exceeding the token limit. Verify before assuming.')
	let kept = lines.filter((l) => /^\[\d+\] (user|assistant):/.test(l)).map((l) => l.replace(/^\[\d+\] /, ''))
	expect(kept).toEqual(['user: p1', 'assistant: a1', 'user: p4', 'assistant: a4', 'user: p5', 'assistant: a5', 'user: p6', 'assistant: a6'])
	// Turns 2 and 3, and each kept turn's call and result, are one line
	// each, under the omitted records' numbers.
	expect(made.summary).toContain('\n[6-14] 2 tool calls, 2 tool results, 2 assistant blocks, 2 prompts omitted\n')
	expect(made.summary).toContain('\n[2-3] 1 tool call, 1 tool result omitted\n')
	expect(lines.at(-1)).toContain('/h/history.asonl')
})

test('empty history has no summary; protected-prompt context still summarises remaining blocks', () => {
	n = 0
	expect(compaction.summary([], '/h')).toBeUndefined()
	expect(compaction.summary([say('hi')], '/h')).toMatchObject({ prompts: 0, summary: expect.stringContaining('1 assistant block omitted') })
})

test('long assistant text keeps its head and tail with a size marker', () => {
	let long = 'H'.repeat(5000) + 'é'.repeat(3000) + 'T'
	let out = compaction.trim(long)
	expect(out.startsWith('H'.repeat(1024) + '[...block of size 11kB trimmed down to 3kB...]')).toBe(true)
	expect(out.endsWith('é'.repeat(1023) + 'T')).toBe(true)
	expect(compaction.trim('short')).toBe('short')
})

test('a second compact summarises from the start, earlier prompts included', () => {
	let first = session(4)
	let made = compaction.summary(first, '/h')!
	let records = [...first, { type: 'compact', ...made, ts, n: ++n } as HistoryRecord, ...turn(5)]
	let again = compaction.summary(records, '/h')!
	expect(again.prompts).toBe(5)
	expect(again.summary).toContain('user: p1')
	expect(again.summary).toContain('user: p5')
	expect(again.summary.split('Context was compacted').length).toBe(2)
})

test('a compact after a reset summarises only what follows the reset', () => {
	let records = [...session(2), { type: 'reset', ts, n: ++n } as HistoryRecord, ...turn(3)]
	let made = compaction.summary(records, '/h')!
	expect(made.prompts).toBe(1)
	expect(made.summary).not.toContain('p1')
	expect(made.summary).toContain('user: p3')
})

test('provider input after a compact is the summary and the records after it', () => {
	let before = session(2)
	let made = compaction.summary(before, '/h')!
	let later = turn(3)
	let messages = replay.toMessages([...before, { type: 'compact', ...made, ts, n: ++n }, ...later])
	expect(messages[0]).toEqual({ role: 'user', blocks: [{ type: 'text', text: made.summary }] })
	let texts = JSON.stringify(messages.slice(1))
	expect(texts).toContain('p3')
	expect(texts).not.toContain('p2')
	expect(messages.slice(1)).toEqual(replay.toMessages(later))
})

test('provider input after a reset holds only later records', () => {
	let later = turn(9)
	expect(replay.toMessages([...session(2), { type: 'reset', ts, n: ++n }, ...later])).toEqual(replay.toMessages(later))
})
