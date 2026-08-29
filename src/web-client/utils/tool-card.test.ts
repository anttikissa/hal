import { expect, test } from 'bun:test'
import { toolCard } from './tool-card.ts'

test('read cards replace their payload with a size summary', () => {
	const card = toolCard.present({ name: 'read', input: { path: 'src/main.ts', start: 10, end: 42 }, output: '10:aaa const x = 1\n11:bbb const y = 2\n' })
	expect(card).toEqual(expect.objectContaining({ title: 'Read src/main.ts (10–42)', detail: '2 lines · 38 B', preview: [] }))
})

test('search cards keep only a phone-sized result sample', () => {
	const card = toolCard.present({ name: 'grep', input: { pattern: 'render', path: 'src' }, output: 'a\nb\nc\nd\ne\nf\ng' })
	expect(card.title).toBe('Grep “render” in src')
	expect(card.preview).toEqual(['a', 'b', 'c', 'd', 'e'])
	expect(card.hiddenLines).toBe(2)
})

test('edit cards report the changed range rather than their complete diff', () => {
	const card = toolCard.present({
		name: 'edit',
		input: { path: 'src/main.ts', operation: 'replace', start: '10:abc', end: '12:def', new_content: 'one\ntwo' },
		output: '--- before\nold\n\n+++ after\nnew',
	})
	expect(card).toEqual(expect.objectContaining({ title: 'Edit src/main.ts', detail: 'Replace lines 10:abc...12:def (3 → 2 lines)', preview: [] }))
})

test('ordinary output is bounded to six lines', () => {
	const card = toolCard.present({ name: 'bash', input: { command: 'git status' }, output: Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join('\n') })
	expect(card.title).toBe('Bash · git status')
	expect(card.preview).toHaveLength(6)
	expect(card.hiddenLines).toBe(3)
})
