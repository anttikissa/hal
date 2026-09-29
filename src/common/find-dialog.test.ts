import { expect, test } from 'bun:test'
import { findDialog } from './find-dialog.ts'
import type { FindKind, FindResult } from './find.ts'

const hit = (blockId: string, score: number, kind: FindKind = 'user'): FindResult => ({ sessionId: '1-abc', name: 'Example', blockId, kind, age: 0, score, snippet: 'needle', href: `/1-abc#${blockId}` })
test('stream replacements rank before navigation, then preserve rows and ignore stale/done batches', () => {
	let m = findDialog.input(findDialog.open([...findDialog.filters]), 'needle')
	m.find!.request = 'a'
	let batch = (results: FindResult[], tier: FindKind = 'user', done = false) => ({ type: 'find-results' as const, request: 'a', tier, results, done })
	m = findDialog.batch(m, batch([hit('1', 1)]))
	m = findDialog.batch(m, batch([hit('2', 5), hit('1', 1)]))
	expect(m.find!.results.map((r) => r.blockId)).toEqual(['2', '1'])
	m = findDialog.step(m, { key: 'down' }).state
	let selected = m.find!.results[m.selected]
	m = findDialog.batch(m, batch([hit('3', 10), hit('2', 5)]))
	m = findDialog.batch(m, batch([hit('4', 20, 'thinking')], 'thinking'))
	expect(m.find!.results[m.selected]).toBe(selected)
	expect(m.find!.results.map((r) => r.blockId)).toEqual(['2', '1', '3', '4'])
	expect(findDialog.batch(m, { ...batch([]), request: 'old' })).toBe(m)
	m = findDialog.batch(m, batch([], 'other', true))
	expect(m.find!.results.length).toBe(4)
	expect(m.find!.done).toBe(true)
	m = findDialog.step(m, { key: 'tab' }).state
	m = findDialog.step(m, { key: ' ' }).state
	expect(m.find!.filters).not.toContain('text')
	expect(m.find!.request).toBeUndefined()
	expect(m.items).toEqual([])
})
