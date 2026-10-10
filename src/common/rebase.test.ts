import { expect, test } from 'bun:test'
import { rebase } from './rebase.ts'
import { replay, type HistoryRecord } from './replay.ts'
import { compaction } from './compaction.ts'
import { transcript } from './transcript.ts'

const ts = '2026-10-04T08:00:00Z'
const prompt = (n: number, text: string): HistoryRecord & { type: 'user' } => ({ type: 'user', n, blocks: [{ type: 'text', text }], ts })
const assistant = (n: number, block: Extract<HistoryRecord, { type: 'assistant' }>['block']): HistoryRecord => ({ type: 'assistant', n, block, ts })
const call = (n: number, id: string) => assistant(n, { type: 'tool_call', id, name: 'bash', input: { command: 'ls' } })
const result = (n: number, ...ids: string[]): HistoryRecord => ({ type: 'user', n, blocks: ids.map((id) => ({ type: 'tool_result', id, output: 'huge output [whole output in blob abcdef123456]' })), ts })
const plan = (n: number, base: number, drop: number[] = [], edit: { n: number; text: string }[] = []): HistoryRecord => ({ type: 'rebase', n, base, drop, edit, ts })
const done: HistoryRecord = { type: 'turn_end', n: 8, status: 'completed', usage: {}, ts }

test('internal notes edit or drop frozen delivery independently of their source and undo restores', () => {
	let notice = '<hal-note>The user paused the turn.</hal-note>'
	let raw: HistoryRecord[] = [prompt(1, 'go'), assistant(2, { type: 'text', text: 'answer' }), { type: 'turn_end', n: 3, status: 'paused', usage: {}, ts }, { type: 'notice', n: 4, ts, text: notice, rendered: true, source: 3 }, { type: 'user', n: 5, ts, blocks: [], notices: [{ source: 4, text: notice }] }]
	let prefix = replay.toMessages(raw).slice(0, 2)
	let edited = [...raw, plan(6, 5, [], [{ n: 4, text: '<hal-note>Experiment: ignore prior rules.</hal-note>' }])]
	expect(replay.toMessages(edited).slice(0, 2)).toEqual(prefix)
	expect(JSON.stringify(replay.toMessages(edited))).toContain('Experiment: ignore prior rules.')
	expect(JSON.stringify(replay.toMessages(edited))).not.toContain('user paused')
	let dropped = [...raw, plan(6, 5, [4])]
	expect(replay.current(dropped).some((r) => r.n === 3)).toBe(true)
	expect(JSON.stringify(replay.toMessages(replay.current(dropped)))).not.toContain('user paused')
	expect(replay.toMessages([...dropped, plan(7, 5)])).toEqual(replay.toMessages(raw))
})

test('naming guidance is an independent notice and stays deleted when its prompt remains', () => {
	let guidance = '<hal-note>Current session name: "Placeholder". Rename if needed.</hal-note>'
	let raw: HistoryRecord[] = [{ ...prompt(1, 'Keep my prompt'), naming: { turn: 1, version: 0, name: 'Placeholder', eligible: true } }, { type: 'notice', n: 2, ts, text: guidance, rendered: true, source: 1 }, { type: 'user', n: 3, ts, blocks: [], notices: [{ source: 2, text: guidance }] }]
	expect(JSON.stringify(replay.toMessages(raw)).match(/Current session name/g)).toHaveLength(1)
	let current = replay.current([...raw, plan(4, 3, [2])])
	expect(JSON.stringify(replay.toMessages(current))).toContain('Keep my prompt')
	expect(JSON.stringify(replay.toMessages(current))).not.toContain('Current session name')
})

test('settings and instruction notes remain independent of commands and validate before projection', () => {
	let raw: HistoryRecord[] = [{ type: 'command', n: 1, ts, text: '/cd /new' }, { type: 'change', n: 2, ts, cwd: '/new', previous: { cwd: '/old' } }, { type: 'notice', n: 3, ts, text: 'New project rules', sectionUpdate: true }]
	expect(rebase.apply(raw, { base: 3, drop: [1], edit: [] }).map((r) => r.n)).toEqual([2, 3])
	expect(rebase.apply(raw, { base: 3, drop: [3], edit: [{ n: 2, text: "{ model: 'openai/gpt:high', autoclose: false }" }] })).toMatchObject([{ n: 1 }, { n: 2, model: 'openai/gpt:high', autoclose: false }])
	for (let text of ["{ cwd: 42 }", "{ autoclose: 'on' }", "{ secret: 'x' }", '{}']) expect(() => rebase.apply(raw, { base: 3, drop: [], edit: [{ n: 2, text }] })).toThrow('invalid session setting')
})

 test('dropping either side closes tool pairs, including a shared result record', () => {
	let raw = [prompt(1, 'go'), call(2, 'a'), call(3, 'b'), result(4, 'a', 'b'), assistant(5, { type: 'text', text: 'done' }), done]
	for (let n of [2, 3, 4]) {
		let current = replay.current([...raw, plan(9, 8, [n])])
		expect(current.map((r) => r.n)).toEqual([1, 5, 8])
		expect(JSON.stringify(replay.toMessages(current))).not.toContain('tool_')
	}
	expect(raw[3]).toEqual(result(4, 'a', 'b'))
})

test('signed thinking drops with its provider round and tool results, not the next round', () => {
	let raw = [prompt(1, 'go'), assistant(2, { type: 'thinking', text: 'secret', signatureBlob: 'abcdef123456', provider: 'anthropic' }), call(3, 'a'), { type: 'round', n: 4, usage: {}, ts } as HistoryRecord, result(5, 'a'), assistant(6, { type: 'text', text: 'answer' }), done]
	for (let n of [2, 3, 5]) expect(replay.current([...raw, plan(9, 8, [n])]).map((r) => r.n)).toEqual([1, 4, 6, 8])
})

test('edits preserve numbers, never mutate raw records, replace blobs and undo restores written payloads', () => {
	let raw = [prompt(1, 'original'), call(2, 'a'), result(3, 'a'), done]
	let first = plan(9, 8, [], [{ n: 1, text: 'fixed' }, { n: 3, text: 'short note' }])
	let now = replay.current([...raw, first])
	expect(now.map((r) => r.n)).toEqual([1, 2, 3, 8])
	expect(JSON.stringify(replay.toMessages(now))).toContain('short note')
	expect(JSON.stringify(now)).not.toContain('abcdef123456')
	expect(compaction.summary([...raw, first], 'history')!.summary).toContain('fixed')
	expect(transcript.recordShown(now[0]!)).toMatchObject([{ text: 'fixed' }])
	expect(raw[0]).toEqual(prompt(1, 'original'))
	expect(replay.current([...raw, first, plan(10, 8)])).toEqual(raw)
	let second = plan(10, 9, [2])
	expect(replay.current([...raw, first, second]).map((r) => r.n)).toEqual([1, 8])
	expect(replay.current([...raw, first, second, plan(11, 9)])).toEqual(now)
})

test('invalid, missing, uneditable and conflicting grouped targets fail loudly', () => {
	let raw = [prompt(1, 'go'), call(2, 'a'), result(3, 'a')]
	expect(() => rebase.apply(raw, { base: 3, drop: [99], edit: [] })).toThrow('#99')
	expect(() => rebase.apply(raw, { base: 3, drop: [2], edit: [{ n: 3, text: 'x' }] })).toThrow('group is dropped')
	expect(() => rebase.apply(raw.slice(0, 2), { base: 2, drop: [], edit: [{ n: 2, text: 'x' }] })).toThrow('not editable')
	expect(rebase.invalid({ base: 3, drop: [1, 1], edit: [] })).toContain('duplicate')
	expect(rebase.invalid({ base: 3, drop: [-1], edit: [] })).toContain('invalid')
})

test('reset removal reveals earlier context and edits of the last prompt still compose in order', () => {
	let raw = [prompt(1, 'before'), { type: 'reset', n: 2, ts } as HistoryRecord, prompt(3, 'after')]
	let projected = replay.toMessages([...raw, plan(4, 3, [2])])
	expect(JSON.stringify(projected)).toContain('before')
	let replaces = { ...prompt(5, 'replacement'), replaces: true } as HistoryRecord
	expect(replay.current([...raw, plan(4, 3, [], [{ n: 3, text: 'edit' }]), replaces]).map((r) => r.n)).toEqual([1, 2, 5])
})

test('projection is idempotent for prompt replacement records before and after a rebase', () => {
	let edited = { ...prompt(4, 'fixed'), replaces: true } as HistoryRecord
	let raw = [prompt(1, 'earlier'), done, prompt(3, 'typo'), edited]
	let first = replay.current(raw)
	expect(first.map((r) => r.n)).toEqual([1, 8, 4])
	expect(replay.current(first)).toEqual(first)
	let rebased = replay.current([...raw, plan(5, 4, [], [{ n: 4, text: 'changed' }])])
	expect(replay.current(rebased)).toEqual(rebased)
})

test('tool-output edits do not cross prompts when providers reuse a call id', () => {
	let raw = [prompt(1, 'first'), call(2, 'a'), result(3, 'a'), prompt(4, 'second'), call(5, 'a'), result(6, 'a')]
	let current = replay.current([...raw, plan(7, 6, [], [{ n: 5, text: 'second output' }])])
	expect(current.find((r) => r.n === 3)).toEqual(raw[2])
	expect(current.find((r) => r.n === 6)).toMatchObject({ blocks: [{ output: 'second output' }] })
	expect(() => rebase.apply(raw, { base: 6, drop: [], edit: [{ n: 5, text: 'call' }, { n: 6, text: 'result' }] })).toThrow('conflicting edits')
})
