import { test, expect } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { rebase } from './rebase.ts'
import type { HistoryEntry } from '../server/sessions.ts'
import { sessions } from '../server/sessions.ts'

function entry(type: string, fields: Record<string, any> = {}): HistoryEntry {
	return { type, ts: '2026-05-22T10:00:00.000Z', ...fields } as HistoryEntry
}

test('renders and parses quoted hashes without treating them as comments', () => {
	const entries = [entry('user', { id: '000001-aaa', parts: [{ type: 'text', text: 'hello #1' }] })]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries, { now: new Date('2026-05-22T10:01:00.000Z') })
	const todo = rebase.renderTodo(snapshot)

	expect(todo).toContain("'hello #1'")
	const parsed = rebase.parseTodo(snapshot, todo)

	expect(parsed.errors).toEqual([])
	expect(parsed.items[0]).toMatchObject({ cmd: 'pick', id: '000001-aaa', content: 'hello #1' })
})


test('renders rebase instructions with full log path and queue examples', () => {
	const snapshot = rebase.buildSnapshot('04-aaa', 'history12.asonl', [])
	const todo = rebase.renderTodo(snapshot)

	expect(todo).toContain('/sessions/04-aaa/history12.asonl (new file: history13.asonl)')
	expect(todo).toContain('# Commands: pick, edit, drop, queue, abort')
	expect(todo).toContain("# queue 000001-aaa user 'edited prompt'")
	expect(todo).toContain(`# queue "quotes; what's up"`)
	expect(todo).toContain('# queue send this without quotes')
})

test('aligns comments by rendered screen width after type prefix', () => {
	const entries = [
		entry('user', { id: '000001-aaa', parts: [{ type: 'text', text: 'short' }] }),
		entry('thinking', { id: '000002-bbb', text: '**Considering Git operations**\n\nI need to inspect the state before continuing.', signature: 'sig', thinkingEffort: 'high' }),
	]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries, { now: new Date('2026-05-22T10:01:00.000Z') })
	const lines = rebase.renderTodo(snapshot).split('\n').filter((line) => line.startsWith('pick '))
	const commentColumns = lines.map((line) => line.indexOf('#'))

	expect(commentColumns).toEqual([66, 66])
})


test('omits tiny char counts and renders rebase marker log', () => {
	const entries = [
		entry('rebased_from', { id: '000001-aaa', log: 'history2.asonl' }),
		entry('user', { id: '000002-bbb', parts: [{ type: 'text', text: 'short' }] }),
	]
	const todo = rebase.renderTodo(rebase.buildSnapshot('04-aaa', 'history3.asonl', entries, { now: new Date('2026-05-22T10:01:00.000Z') }))

	expect(todo).toContain("rebased_from { log: 'history2.asonl' }")
	expect(todo).not.toContain('5 chars')
})

test('queue rows must be a suffix', () => {
	const entries = [
		entry('user', { id: '000001-aaa', parts: [{ type: 'text', text: 'first' }] }),
		entry('assistant', { id: '000002-bbb', text: 'second' }),
	]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries)
	const todo = [
		'queue hello',
		"pick 000002-bbb assistant 'second' # later",
	].join('\n')

	const parsed = rebase.parseTodo(snapshot, todo)

	expect(parsed.errors).toContain('Queue rows must be the final non-comment lines.')
})

test('thinking content edits are ignored', async () => {
	const entries = [entry('thinking', { id: '000001-aaa', text: 'secret', signature: 'sig' })]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries)
	const parsed = rebase.parseTodo(snapshot, "edit 000001-aaa thinking 'changed' # ignored")
	const applied = await rebase.applyParsed(snapshot, parsed)

	expect(parsed.errors).toEqual([])
	expect(applied.entries).toEqual(entries)
})


test('picked rows keep their original ids', async () => {
	const entries = [entry('assistant', { id: '000001-aaa', text: 'same row' })]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries)
	const parsed = rebase.parseTodo(snapshot, rebase.renderTodo(snapshot))
	const applied = await rebase.applyParsed(snapshot, parsed)

	expect(applied.entries[0]?.id).toBe('000001-aaa')
})


test('edit command uses external edited text payload', async () => {
	const entries = [entry('user', { id: '000001-aaa', parts: [{ type: 'text', text: 'old text' }] })]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries)
	const parsed = rebase.parseTodo(snapshot, "edit 000001-aaa user 'old text'", { edits: { '000001-aaa': 'new text' } })
	const applied = await rebase.applyParsed(snapshot, parsed)

	expect(parsed.errors).toEqual([])
	expect(applied.entries[0]).toMatchObject({ type: 'user', parts: [{ type: 'text', text: 'new text' }] })
})


test('edit command roundtrips image placeholders through prompt attachment parsing', async () => {
	const testDir = '/tmp/hal-test-rebase'
	const sessionId = '04-aaa'
	const sessionDir = `${testDir}/sessions/${sessionId}`
	const image1 = `${testDir}/one.png`
	const image2 = `${testDir}/two.png`
	const originalSessionDir = sessions.sessionDir
	try {
		sessions.sessionDir = (id: string) => `${testDir}/sessions/${id}`
		mkdirSync(`${sessionDir}/blobs`, { recursive: true })
		writeFileSync(`${sessionDir}/session.ason`, `{ createdAt: '2026-05-22T10:00:00.000Z' }\n`)
		writeFileSync(image1, 'fake png 1')
		writeFileSync(image2, 'fake png 2')

		const entries = [entry('user', {
			id: '000001-aaa',
			parts: [
				{ type: 'text', text: 'hello this is image ' },
				{ type: 'image', blobId: 'old1', originalFile: image1 },
				{ type: 'text', text: ' and this is another ' },
				{ type: 'image', blobId: 'old2', originalFile: image2 },
				{ type: 'text', text: ' etc.' },
			],
		})]
		const snapshot = rebase.buildSnapshot(sessionId, 'history.asonl', entries)
		const originalText = `hello this is image [${image1}] and this is another [${image2}] etc.`

		expect(rebase.editTexts(snapshot)['000001-aaa']).toBe(originalText)
		const parsed = rebase.parseTodo(snapshot, `edit 000001-aaa user ${JSON.stringify(originalText)}`, { edits: { '000001-aaa': `edited [${image2}] then [${image1}] done` } })
		const applied = await rebase.applyParsed(snapshot, parsed)

		expect(parsed.errors).toEqual([])
		expect(applied.entries[0]).toMatchObject({
			type: 'user',
			parts: [
				{ type: 'text', text: 'edited ' },
				{ type: 'image', originalFile: image2 },
				{ type: 'text', text: ' then ' },
				{ type: 'image', originalFile: image1 },
				{ type: 'text', text: ' done' },
			],
		})
	} finally {
		sessions.sessionDir = originalSessionDir
		if (existsSync(testDir)) rmSync(testDir, { recursive: true })
	}
})

test('queue existing truncated user uses snapshot text and omits row from history', async () => {
	const entries = [entry('user', { id: '000001-aaa', parts: [{ type: 'text', text: `${'x'.repeat(120)}\nsecond` }] })]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries)
	const parsed = rebase.parseTodo(snapshot, "queue 000001-aaa user 'ignored... # truncated")

	expect(parsed.errors).toEqual([])
	const applied = await rebase.applyParsed(snapshot, parsed)

	expect(applied.entries).toEqual([])
	expect(applied.queue).toEqual([`${'x'.repeat(120)}\nsecond`])
})


test('queue existing user row uses edited non-truncated content', async () => {
	const entries = [entry('user', { id: '000001-aaa', parts: [{ type: 'text', text: '1, 2, 3...' }] })]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries)
	const parsed = rebase.parseTodo(snapshot, "queue 000001-aaa user 'a, b, c...'")
	const applied = await rebase.applyParsed(snapshot, parsed)

	expect(parsed.errors).toEqual([])
	expect(applied.entries).toEqual([])
	expect(applied.queue).toEqual(['a, b, c...'])
})

test('tool rows write contiguous calls first then results in visible order', async () => {
	const entries = [
		entry('tool_call', { id: '000001-aaa', toolId: 't1', name: 'read', input: { path: 'a' } }),
		entry('tool_call', { id: '000002-bbb', toolId: 't2', name: 'grep', input: { pattern: 'b' } }),
		entry('tool_result', { id: '000003-ccc', toolId: 't1', output: 'A' }),
		entry('tool_result', { id: '000004-ddd', toolId: 't2', output: 'B' }),
	]
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', entries)
	const toolRows = snapshot.rows.filter((row) => row.type === 'tool')
	const todo = [
		rebase.renderRow({ ...toolRows[1]!, cmd: 'pick' }),
		rebase.renderRow({ ...toolRows[0]!, cmd: 'pick' }),
	].join('\n')

	const parsed = rebase.parseTodo(snapshot, todo)
	const applied = await rebase.applyParsed(snapshot, parsed)

	expect(applied.entries.map((item) => {
		if (item.type === 'tool_call') return `C:${item.toolId}`
		if (item.type === 'tool_result') return `R:${item.toolId}`
		return item.type
	})).toEqual(['C:t2', 'C:t1', 'R:t2', 'R:t1'])
})

test('manual queue supports quoted hashes and raw comments', async () => {
	const snapshot = rebase.buildSnapshot('04-aaa', 'history.asonl', [])
	const parsed = rebase.parseTodo(snapshot, [
		"queue 'hello #1' # comment",
		'queue formula #1',
	].join('\n'))
	const applied = await rebase.applyParsed(snapshot, parsed)

	expect(parsed.errors).toEqual([])
	expect(applied.queue).toEqual(['hello #1', 'formula'])
})
