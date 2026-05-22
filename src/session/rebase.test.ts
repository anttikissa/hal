import { test, expect } from 'bun:test'
import { rebase } from './rebase.ts'
import type { HistoryEntry } from '../server/sessions.ts'

function entry(type: string, fields: Record<string, any> = {}): HistoryEntry {
	return { type, ts: '2026-05-22T10:00:00.000Z', ...fields } as HistoryEntry
}

test('renders and parses quoted hashes without treating them as comments', () => {
	const entries = [entry('user', { entryId: '000001-aaa', parts: [{ type: 'text', text: 'hello #1' }] })]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries, { now: new Date('2026-05-22T10:01:00.000Z') })
	const todo = rebase.renderTodo(snapshot)

	expect(todo).toContain("'hello #1'")
	const parsed = rebase.parseTodo(snapshot, todo)

	expect(parsed.errors).toEqual([])
	expect(parsed.items[0]).toMatchObject({ cmd: 'pick', id: '000001-aaa', content: 'hello #1' })
})

test('queue rows must be a suffix', () => {
	const entries = [
		entry('user', { entryId: '000001-aaa', parts: [{ type: 'text', text: 'first' }] }),
		entry('assistant', { entryId: '000002-bbb', text: 'second' }),
	]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries)
	const todo = [
		'queue hello',
		"pick 000002-bbb assistant 'second' # later",
	].join('\n')

	const parsed = rebase.parseTodo(snapshot, todo)

	expect(parsed.errors).toContain('Queue rows must be the final non-comment lines.')
})

test('thinking content edits are ignored', () => {
	const entries = [entry('thinking', { entryId: '000001-aaa', text: 'secret', signature: 'sig' })]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries)
	const parsed = rebase.parseTodo(snapshot, "edit 000001-aaa thinking 'changed' # ignored")
	const applied = rebase.applyParsed(snapshot, parsed)

	expect(parsed.errors).toEqual([])
	expect(applied.entries).toEqual(entries)
})

test('queue existing truncated user uses snapshot text and omits row from history', () => {
	const entries = [entry('user', { entryId: '000001-aaa', parts: [{ type: 'text', text: `${'x'.repeat(120)}\nsecond` }] })]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries)
	const parsed = rebase.parseTodo(snapshot, "queue 000001-aaa user 'ignored... # truncated")

	expect(parsed.errors).toEqual([])
	const applied = rebase.applyParsed(snapshot, parsed)

	expect(applied.entries).toEqual([])
	expect(applied.queue).toEqual([`${'x'.repeat(120)}\nsecond`])
})

test('tool rows write contiguous calls first then results in visible order', () => {
	const entries = [
		entry('tool_call', { entryId: '000001-aaa', toolId: 't1', name: 'read', input: { path: 'a' } }),
		entry('tool_call', { entryId: '000002-bbb', toolId: 't2', name: 'grep', input: { pattern: 'b' } }),
		entry('tool_result', { entryId: '000003-ccc', toolId: 't1', output: 'A' }),
		entry('tool_result', { entryId: '000004-ddd', toolId: 't2', output: 'B' }),
	]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries)
	const toolRows = snapshot.rows.filter((row) => row.type === 'tool')
	const todo = [
		rebase.renderRow({ ...toolRows[1]!, cmd: 'pick' }),
		rebase.renderRow({ ...toolRows[0]!, cmd: 'pick' }),
	].join('\n')

	const parsed = rebase.parseTodo(snapshot, todo)
	const applied = rebase.applyParsed(snapshot, parsed)

	expect(applied.entries.map((item) => {
		if (item.type === 'tool_call') return `C:${item.toolId}`
		if (item.type === 'tool_result') return `R:${item.toolId}`
		return item.type
	})).toEqual(['C:t2', 'C:t1', 'R:t2', 'R:t1'])
})

test('manual queue supports quoted hashes and raw comments', () => {
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', [])
	const parsed = rebase.parseTodo(snapshot, [
		"queue 'hello #1' # comment",
		'queue formula #1',
	].join('\n'))
	const applied = rebase.applyParsed(snapshot, parsed)

	expect(parsed.errors).toEqual([])
	expect(applied.queue).toEqual(['hello #1', 'formula'])
})
