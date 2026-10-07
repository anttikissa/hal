import { expect, test } from 'bun:test'
import { rebaseRows } from './rebase-rows.ts'
import { rebaseSparse } from './rebase-sparse.ts'
import type { HistoryRecord } from './replay.ts'
const records: HistoryRecord[] = [
	{ n: 1, ts: '', type: 'user', blocks: [{ type: 'text', text: 'prompt' }] },
	{ n: 2, ts: '', type: 'assistant', block: { type: 'text', text: 'answer' } },
	{ n: 3, ts: '', type: 'assistant', block: { type: 'tool_call', name: 'bash', id: 'call', input: {} } },
	{ n: 4, ts: '', type: 'user', blocks: [{ type: 'tool_result', id: 'call', output: 'result' }] },
]
const snapshot = rebaseRows.build(records)
test('sparse selectors keep omitted rows, bare ranges include all kinds, prefixes filter singles and ranges', () => {
	expect(rebaseSparse.parse('drop #1-2', snapshot).plan.drop).toEqual([1, 2])
	expect(rebaseSparse.parse('drop a1-4, #t3', snapshot).plan.drop).toEqual([2, 3, 4])
	expect(() => rebaseSparse.parse('drop t1', snapshot)).toThrow('no entries')
	expect(rebaseSparse.parse('edit #t3 "new output"', snapshot).plan.edit).toEqual([{ n: 4, text: 'new output' }])
})
test('quoted full replacements preserve semicolons, whitespace and literal interpolation, decode only explicit escapes', () => {
	for (let quote of ['"', "'", '`']) {
		let text = `edit 1 ${quote}  x; $\{literal}\\nline\\t\\\\\\${quote}${quote}; drop 2`
		expect(rebaseSparse.parse(text, snapshot).plan).toMatchObject({ drop: [2], edit: [{ n: 1, text: `  x; $\{literal}\nline\t\\${quote}` }] })
	}
	for (let text of ['edit 1 "\\u1234"', 'edit 1 "\\r"', 'edit 1 "unfinished', 'edit 1 "x" trailing', 'edit 1 "x";', 'insert 1 "x"', 'edit 1 "x"; drop 1']) expect(() => rebaseSparse.parse(text, snapshot)).toThrow()
})
test('open tails resolve against application rows, including later linked call results', () => {
	let sparse = rebaseSparse.parse('drop 3-', rebaseRows.build(records.slice(0, 2)))
	expect(sparse.plan.drop).toEqual([])
	expect(rebaseSparse.resolve(sparse, snapshot).drop).toEqual([3, 4])
	expect(rebaseSparse.resolve(rebaseSparse.parse('drop a*', snapshot), snapshot).drop).toEqual([2])
})

test('tool names do not turn command-tool entries into system commands', () => {
	let snapshot = rebaseRows.build([
		{ n: 1, ts: '', type: 'assistant', block: { type: 'tool_call', name: 'command', id: 'cmd', input: { command: '/rebase show' } } },
		{ n: 2, ts: '', type: 'command', text: '/rebase show', origin: 'model' },
	])
	expect(rebaseSparse.parse('drop t*', snapshot).plan.drop).toEqual([1])
	expect(rebaseSparse.parse('drop s*', snapshot).plan.drop).toEqual([2])
})
