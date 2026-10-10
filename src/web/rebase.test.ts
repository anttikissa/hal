import { afterEach, expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import { rebaseRows } from '../common/rebase-rows.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { app } from './app.ts'
import { rebaseView } from './rebase.ts'

const ts = new Date(2026, 9, 4, 9, 0).toISOString()
const records: HistoryRecord[] = [
	{ type: 'user', n: 1, ts, blocks: [{ type: 'text', text: 'Fix the bug' }] },
	{ type: 'assistant', n: 2, ts, block: { type: 'thinking', text: 'Hmm', signature: 'sig' } },
	{ type: 'assistant', n: 3, ts, block: { type: 'tool_call', id: 'a', name: 'bash', input: { command: './test' } } },
	{ type: 'user', n: 4, ts, blocks: [{ type: 'tool_result', id: 'a', output: 'x'.repeat(40_000) }] },
	{ type: 'assistant', n: 5, ts, block: { type: 'text', text: 'Done' } },
]
const plan = (snapshot = rebaseRows.build(records)) => ({ type: 'rebase-plan' as const, sessionId: 's1', snapshot, todo: '' })
const saved = { send: connection.send, nextId: connection.nextId }
let sent: unknown[] = []

afterEach(() => {
	Object.assign(connection, saved)
	rebaseView.state = undefined
	app.reset()
})

function start() {
	sent = []
	connection.send = (c) => void sent.push(c)
	connection.nextId = () => 'c1'
	rebaseView.open(plan())
	return rebaseView.state!
}

test('internal notes open, edit and drop independently of session setting rows', () => {
	let snapshot = rebaseRows.build([{ type: 'change', n: 1, ts, cwd: '/new' }, { type: 'notice', n: 2, ts, text: 'New rules\nfull instructions', sectionUpdate: true }])
	rebaseView.open(plan(snapshot))
	let st = rebaseView.state!
	expect(rebaseView.parts(st, snapshot.rows[1]!)).toEqual([{ kind: 'text', label: 'internal note', text: 'New rules\nfull instructions' }])
	rebaseView.act(2, 'edit')
	rebaseView.edit(2, 'Injected rules')
	rebaseView.act(1, 'drop')
	expect(rebaseView.plan(rebaseView.state!)).toEqual({ base: 2, drop: [1], edit: [{ n: 2, text: 'Injected rules' }] })
})

test('a drop takes its whole group, and keeping a member keeps the group', () => {
	start()
	rebaseView.act(3, 'drop')
	let st = rebaseView.state!
	expect(st.snapshot.rows.map((r) => rebaseView.shown(st, r))).toEqual(['keep', 'group', 'drop', 'keep'])
	expect(rebaseView.plan(st).drop).toEqual([3, 4])
	rebaseView.act(2, 'keep')
	expect(rebaseView.plan(rebaseView.state!).drop).toEqual([])
})

test('shift-click and range mode act from the anchor; edit stays on one row', () => {
	start()
	rebaseView.act(1, 'drop')
	rebaseView.act(3, 'drop', true)
	expect(Object.keys(rebaseView.state!.actions)).toEqual(['1', '2', '3'])
	rebaseView.range(true)
	rebaseView.act(5, 'keep')
	expect(rebaseView.state!.range).toBe(true)
	rebaseView.act(2, 'keep')
	expect(rebaseView.state!.actions).toEqual({ 1: 'drop' })
	expect(rebaseView.state!.range).toBe(false)
	rebaseView.act(5, 'edit', true)
	expect(rebaseView.state!.actions).toEqual({ 1: 'drop', 5: 'edit' })
})

test('only changed edits outside dropped groups reach the plan, and Apply needs a change', () => {
	start()
	rebaseView.act(5, 'edit')
	rebaseView.apply()
	expect(sent).toEqual([])
	rebaseView.edit(5, 'Finished')
	rebaseView.act(3, 'edit')
	rebaseView.edit(3, 'short note')
	expect(rebaseView.plan(rebaseView.state!).edit).toEqual([{ n: 4, text: 'short note' }, { n: 5, text: 'Finished' }])
	rebaseView.act(2, 'drop')
	expect(rebaseView.plan(rebaseView.state!).edit).toEqual([{ n: 5, text: 'Finished' }])
	rebaseView.apply()
	expect(sent).toEqual([{ type: 'rebase-apply', id: 'c1', sessionId: 's1', base: 5, plan: { base: 5, drop: [2], edit: [{ n: 5, text: 'Finished' }] } }])
})

test('quick actions drop big tool output and everything before a row', () => {
	start()
	rebaseView.threshold(1000)
	rebaseView.dropOver()
	expect(rebaseView.state!.actions).toEqual({ 3: 'drop' })
	rebaseView.dropBefore(5)
	expect(Object.keys(rebaseView.state!.actions)).toEqual(['1', '2', '3'])
})

test('the host answer: a refusal stays whole with the plan, success closes with its text, others are ignored', () => {
	start()
	rebaseView.act(1, 'drop')
	rebaseView.apply()
	let refusal = 'Rebase is stale: base #5, latest record #7. Rebuild the plan.'
	expect(rebaseView.onEvent({ type: 'rebase-result', sessionId: 's1', command: 'other', ok: false, text: 'no' })).toBe(true)
	expect(rebaseView.state!.sending).toBe('c1')
	rebaseView.onEvent({ type: 'rebase-result', sessionId: 's1', command: 'c1', ok: false, text: refusal })
	expect(rebaseView.state).toMatchObject({ error: refusal, sending: undefined, actions: { 1: 'drop' } })
	// A rebuilt plan keeps choices for rows that still exist.
	rebaseView.open(plan(rebaseRows.build(records.slice(0, 2))))
	expect(rebaseView.state!.actions).toEqual({ 1: 'drop' })
	rebaseView.apply()
	rebaseView.onEvent({ type: 'rebase-result', sessionId: 's1', command: 'c1', ok: true, text: 'History rewritten.' })
	expect(rebaseView.state).toBeUndefined()
	expect(app.notice()).toBe('History rewritten.')
})

test('an opened row shows readable parts, not JSON', () => {
	let st = start()
	let parts = rebaseView.parts(st, st.snapshot.rows[2]!)
	expect(parts.map((p) => p.kind === 'text' ? [p.label, p.text.slice(0, 8)] : p.kind)).toEqual([['call', '$ ./test'], ['output', 'xxxxxxxx']])
})
