import { expect, test } from 'bun:test'
import { findDialog } from './find-dialog.ts'
import type { FindKind, FindResult } from './find.ts'

const hit = (blockId: string, score: number, kind: FindKind = 'user', count = 0): FindResult => ({
	sessionId: count ? `${blockId}-abc` : '1-abc',
	name: 'Example',
	blockId,
	card: `u${blockId}`,
	kind,
	why: 'request',
	count,
	cwd: '~/x',
	age: 0,
	score,
	snippet: 'needle',
	href: `/1-abc#${blockId}`,
})
const batch = (results: FindResult[], tier: FindKind = 'user', done = false) => ({
	type: 'find-results' as const,
	request: 'a',
	tier,
	results,
	done,
})
test('batches replace the ranking until the selection moves, then preserve rows and ignore stale/done batches', () => {
	let m = findDialog.input(findDialog.open([...findDialog.filters]), 'needle')
	m.find!.request = 'a'
	m = findDialog.batch(m, batch([hit('1', 1)]))
	m = findDialog.batch(m, batch([hit('2', 5), hit('1', 1)]))
	expect(m.find!.results.map((r) => r.blockId)).toEqual(['2', '1'])
	m = findDialog.step(findDialog.step(m, { key: 'down' }).state, { key: 'down' }).state
	expect(m.find!.focus).toBe(findDialog.resultsFocus)
	let selected = m.find!.results[m.selected]
	m = findDialog.batch(m, batch([hit('3', 10), hit('2', 5), hit('1', 1)]))
	m = findDialog.batch(m, batch([hit('4', 20, 'thinking')], 'thinking'))
	expect(m.find!.results[m.selected]).toBe(selected)
	expect(m.find!.results.map((r) => r.blockId)).toEqual(['2', '1', '3', '4'])
	expect(findDialog.batch(m, { ...batch([]), request: 'old' })).toBe(m)
	m = findDialog.batch(m, batch([], 'other', true))
	expect(m.find!.results.length).toBe(4)
	expect(m.find!.done).toBe(true)
	// Up from the first result reaches the filters; Right and Space toggle the second.
	m = findDialog.step(m, { key: 'up' }).state
	m = findDialog.step(findDialog.step(m, { key: 'right' }).state, { key: ' ' }).state
	expect(m.find!.filters).not.toContain('hal')
	expect(m.find!.focus).toBe(2)
	expect(m.find!.request).toBeUndefined()
	// The old rows stay until the new search answers, even with nothing.
	expect(m.items.length).toBe(4)
	m.find!.request = 'b'
	m = findDialog.batch(m, { ...batch([], 'other', true), request: 'b' })
	expect(m.items).toEqual([])
})
test('Right lists a tab row as cards, keeping kind values; Left restores the query', () => {
	let m = findDialog.input(findDialog.open([...findDialog.filters]), 'blink in:tools,10-19')
	m.find!.request = 'a'
	m = findDialog.batch(m, batch([hit('7', 5, 'user', 3)]))
	m = findDialog.focus(m, findDialog.resultsFocus)
	m = findDialog.step(m, { key: 'right' }).state
	expect(m.form!.values[0]).toBe('blink in:tools in:7-abc')
	expect(m.find!.focus).toBe(findDialog.resultsFocus)
	m = findDialog.step(m, { key: 'left' }).state
	expect(m.form!.values[0]).toBe('blink in:tools,10-19')
	expect(m.find!.back).toBeUndefined()
})
