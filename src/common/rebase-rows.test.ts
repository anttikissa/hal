import { expect, test } from 'bun:test'
import { inbox } from './inbox.ts'
import { rebaseRows } from './rebase-rows.ts'
import { replay, type HistoryRecord } from './replay.ts'

const ts = new Date(2026, 9, 4, 9, 0).toISOString()
const prompt = (n: number, text: string): HistoryRecord & { type: 'user' } => ({ type: 'user', n, ts, blocks: [{ type: 'text', text }] })
const say = (n: number, text: string): HistoryRecord => ({ type: 'assistant', n, ts, block: { type: 'text', text } })
const call: HistoryRecord = { type: 'assistant', n: 3, ts, block: { type: 'tool_call', id: 'a', name: 'bash', input: { command: './test' } } }
const result: HistoryRecord = { type: 'user', n: 5, ts, blocks: [{ type: 'tool_result', id: 'a', output: 'output cut; whole output in blob abcdef123456', image: { type: 'image', blob: '123456abcdef', mediaType: 'image/png', bytes: 500 } }] }

test('internal notes and settings are independently editable rows in terminal and model plans', () => {
	let raw: HistoryRecord[] = [{ type: 'command', n: 1, ts, text: '/cd /new' }, { type: 'change', n: 2, ts, cwd: '/new', autoclose: true }, { type: 'notice', n: 3, ts, text: 'Project rules\nfull content', sectionUpdate: true }, { type: 'notice', n: 4, ts, text: 'Host fact' }]
	let snapshot = rebaseRows.build(raw)
	expect(snapshot.rows.map((r) => [r.n, r.kind, r.editable, r.group])).toEqual([[1, 'command', false, [1]], [2, 'settings', true, [2]], [3, 'instructions', true, [3]], [4, 'note', true, [4]]])
	let todo = rebaseRows.render('example', snapshot).replace(/^keep\s+#3/m, 'edit  #3')
	let parsed = rebaseRows.parse(todo, snapshot, { 3: 'Injected instructions' })
	expect(parsed.plan.edit).toEqual([{ n: 3, text: 'Injected instructions' }])
	expect(rebaseRows.parse(todo.replace(/^keep\s+#2.*\n/m, ''), snapshot, { 3: 'Injected instructions' }).plan.drop).toEqual([2])
})

test('rows pair calls across interleaved records, group commands with outputs and show attachment metadata', () => {
	let raw: HistoryRecord[] = [prompt(1, 'First line\nsecond'), { type: 'assistant', n: 2, ts, block: { type: 'thinking', text: 'Considering options', signature: 'sig' } }, call, { type: 'round', n: 4, ts, usage: {} }, result, say(6, 'Answer'), { type: 'command', n: 7, ts, text: '/example' }, { type: 'output', n: 8, ts, text: 'command output' }, { type: 'compact', n: 9, ts, summary: 'summary', prompts: 1 }, { type: 'reset', n: 10, ts }]
	let snapshot = rebaseRows.build(raw, { blobSizes: { abcdef123456: 1_400_000 }, pruned: [3] })
	expect(snapshot.rows.map((r) => [r.n, r.kind, r.ns])).toEqual([[1, 'prompt', [1]], [2, 'thinking', [2]], [3, 'bash', [3, 5]], [6, 'assistant', [6]], [7, 'command', [7, 8]], [9, 'compact', [9]], [10, 'reset', [10]]])
	expect(snapshot.rows[0]!.summary).toBe('First line')
	expect(snapshot.rows[2]).toMatchObject({ summary: '$ ./test', editable: true, editN: 5, group: [2, 3, 5] })
	expect(snapshot.rows[2]!.carries).toEqual(['1 image', 'blob abcdef123456 1.4 MB', 'output cut', 'drop group #2, #3, #5', 'pruned'])
	expect(snapshot.rows[0]!.time).toBe('2026-10-04 09:00')
	expect(snapshot.rows[1]!.time).toBe('09:00')
})

test('calibrated row estimates and plan totals account for edits, paired drops and cache record order', () => {
	let raw = [prompt(20, 'abcdef'), say(2, 'uvwxyz'), call, result]
	let snapshot = rebaseRows.build(raw, { model: 'example/m', ratios: { 'example/m': 2 } })
	expect(snapshot.rows[0]!.tokens).toBe(3)
	expect(rebaseRows.build(raw).rows[0]!.tokens).toBe(2)
	let plan = { base: 5, drop: [5], edit: [{ n: 20, text: 'ab' }] }
	let sums = rebaseRows.totals(snapshot, plan)
	expect(sums).toMatchObject({ rows: 3, after: 4, cacheFrom: 20 })
	expect(sums.tokens).toBeGreaterThan(sums.after)
	expect(rebaseRows.totals(snapshot).cacheFrom).toBeUndefined()
	expect(rebaseRows.totals(snapshot, { base: 5, drop: [], edit: [{ n: 20, text: 'abcdef' }] }).cacheFrom).toBeUndefined()
})

test('todo round-trips keep, deletion drops paired records, and edits target the result rather than the call', () => {
	let snapshot = rebaseRows.build([prompt(1, 'original'), say(2, 'answer'), call, result])
	let text = rebaseRows.render('157-gut', snapshot)
	expect(rebaseRows.parse(text, snapshot)).toEqual({ plan: { base: 5, drop: [], edit: [] }, queue: [], edits: [], aborted: false, inline: {} })
	let changed = text.replace(/^keep\s+#1.*\n/m, '').replace(/^keep\s+#3/m, 'edit  #3') + 'queue Next prompt\nqueue Then this\n'
	let pending = rebaseRows.parse(changed, snapshot)
	expect(pending.plan.drop).toEqual([1])
	expect(pending.edits).toEqual([3])
	let parsed = rebaseRows.parse(changed, snapshot, { 3: 'short note' })
	expect(parsed.plan.edit).toEqual([{ n: 5, text: 'short note' }])
	expect(parsed.queue).toEqual(['Next prompt', 'Then this'])
	expect(JSON.stringify(replay.toMessages([prompt(1, 'start'), ...snapshot.records.slice(1), { type: 'rebase', ...parsed.plan, drop: [], n: 6, ts }]))).not.toContain('abcdef123456')
	let deleted = rebaseRows.parse(text.replace(/^keep\s+#3.*\n/m, ''), snapshot)
	expect(deleted.plan.drop).toEqual([3, 5])
})

test('a changed summary edits the first line in place; changed columns or tool rows fail', () => {
	let snapshot = rebaseRows.build([prompt(1, 'First line\nsecond $&'), say(2, 'answer'), call, result])
	let text = rebaseRows.render('167-dam', snapshot)
	let tail = text.replace('First line', () => 'Fixed $& line').replace(/^keep\s+#2[\s\S]*/m, '')
	expect(rebaseRows.parse(tail, snapshot).plan).toEqual({ base: 5, drop: [2, 3, 5], edit: [{ n: 1, text: 'Fixed $& line\nsecond $&' }] })
	let opened = rebaseRows.parse(tail.replace(/^keep/m, 'edit'), snapshot)
	expect([opened.edits, opened.inline]).toEqual([[1], { 1: 'Fixed $& line\nsecond $&' }])
	expect(() => rebaseRows.parse(text.replace('$ ./test', '$ ./test -v'), snapshot)).toThrow('Rebase line 7: #3 changed')
	expect(() => rebaseRows.parse(text.replace(/prompt(\s+)/, 'answer$1'), snapshot)).toThrow('Rebase line 5: #1 changed')
})

test('todo format header reports planned savings and preserves deterministic row layout', () => {
	let snapshot = rebaseRows.build([prompt(12, 'First line\nrest'), say(13, 'answer')])
	let text = rebaseRows.render('157-gut', snapshot, { base: 13, drop: [13], edit: [] })
	expect(text).toBe("# Changing or deleting a message invalidates the cache from that point onward.\n# Rebase 157-gut · 2 rows · 7 tokens → 5 after · cache rebuilds from #13\n# keep/drop/edit/queue; delete a line = drop; empty file or 'abort' cancels\n# edit opens the full text next; queue lines go last and are sent after\nkeep  #12  2026-10-04 09:00  prompt     5  First line\ndrop  #13  09:00             assistant  2  answer\n")
})

test('todo rejects duplicate/unknown/reordered rows, queue placement and uneditable text with line numbers', () => {
	let snapshot = rebaseRows.build([prompt(1, 'go'), say(2, 'done'), call])
	for (let [text, message] of [
		['keep #1\nkeep #1', 'line 2: duplicate'], ['keep #99', 'line 1: unknown'], ['keep #2\nkeep #1', 'line 2: reordering'],
		['queue next\nkeep #1', 'line 2: queue'], ['edit #3', 'line 1: record #3 is not editable'], ['wat #1', 'line 1: expected'], ['queue', 'line 1: expected'],
	]) expect(() => rebaseRows.parse(text!, snapshot)).toThrow(message!)
	for (let text of ['', '# comments only\n', 'abort\n', 'keep #1\nabort\n']) expect(rebaseRows.parse(text, snapshot).aborted).toBe(true)
	expect(rebaseRows.parse('pick #1\nkeep #2\nkeep #3', snapshot).plan.drop).toEqual([])
})

test('multi-result rows edit one output through its call number and expose paired drop groups', () => {
	let second: HistoryRecord = { ...call, n: 4, block: { type: 'tool_call', id: 'b', name: 'read', input: { path: 'file.txt' } } }
	let multi: HistoryRecord = { ...result, blocks: [{ type: 'tool_result', id: 'a', output: 'a' }, { type: 'tool_result', id: 'b', output: 'b' }] }
	let snapshot = rebaseRows.build([prompt(1, 'go'), call, second, multi])
	expect(new Set(snapshot.rows[1]!.group)).toEqual(new Set([3, 5, 4]))
	let edited = rebaseRows.parse('keep #1\nedit #3\nkeep #4', snapshot, { 3: 'changed a' })
	expect(edited.plan.edit).toEqual([{ n: 3, text: 'changed a' }])
	let current = replay.current([...snapshot.records, { type: 'rebase', ...edited.plan, n: 6, ts }])
	expect(current.find((r) => r.n === 5)).toMatchObject({ blocks: [{ id: 'a', output: 'changed a' }, { id: 'b', output: 'b' }] })
	let parsed = rebaseRows.parse('keep #1\ndrop #3\nkeep #4', snapshot)
	expect(replay.current([...snapshot.records, { type: 'rebase', ...parsed.plan, n: 6, ts }]).map((r) => r.n)).toEqual([1])
})

test('deleting one row of a signed drop group refuses another edited row with its todo line', () => {
	let snapshot = rebaseRows.build([prompt(1, 'go'), { type: 'assistant', n: 2, ts, block: { type: 'thinking', text: 'reason', signature: 'sig' } }, say(3, 'answer')])
	expect(() => rebaseRows.parse('keep #1\nedit #3', snapshot)).toThrow('line 2: edited record #3 belongs to a dropped group')
})

test('waiting messages are editable rows; dropping removes all revisions and undo restores the inbox', () => {
	let raw: HistoryRecord[] = [prompt(1, 'go'), { type: 'inbox', n: 2, ts, id: 'message', text: 'original', from: 'other-session', label: 'Other session', delivery: 'next-round' }, { type: 'inbox', n: 3, ts, id: 'message', text: 'current', from: 'other-session', label: 'Other session', delivery: 'next-round' }]
	let snapshot = rebaseRows.build(raw)
	expect(snapshot.rows[1]).toMatchObject({ n: 2, ns: [2, 3], kind: 'interjecting', summary: 'Other session: current', editN: 3, text: 'current' })
	let edited = rebaseRows.parse('keep #1\nedit #2', snapshot, { 2: 'replacement' })
	let current = replay.current([...raw, { type: 'rebase', n: 4, ts, ...edited.plan }])
	expect(inbox.pending(current)).toMatchObject([{ n: 2, text: 'replacement', from: 'other-session', delivery: 'next-round' }])
	let dropped = rebaseRows.parse('keep #1', snapshot)
	let rewrite: HistoryRecord = { type: 'rebase', n: 4, ts, ...dropped.plan }
	expect(inbox.pending(replay.current([...raw, rewrite]))).toEqual([])
	expect(inbox.pending(replay.current([...raw, rewrite, { type: 'rebase', n: 5, ts, base: 3, drop: [], edit: [] }]))).toMatchObject([{ text: 'current' }])
})

test('dropping a delivered prompt never resurrects its inbox messages', () => {
	let raw: HistoryRecord[] = [prompt(1, 'go'), { type: 'inbox', n: 2, ts, id: 'message', text: 'from another session', from: 'other-session' }, { ...prompt(3, 'from another session'), inbox: ['message'] }]
	let snapshot = rebaseRows.build(raw)
	expect(snapshot.rows.map((row) => row.n)).toEqual([1, 3])
	let dropped = rebaseRows.parse('keep #1', snapshot)
	let current = replay.current([...raw, { type: 'rebase', n: 4, ts, ...dropped.plan }])
	expect(inbox.pending(current)).toEqual([])
	expect(current.map((r) => r.n)).toEqual([1])
})
