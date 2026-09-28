import { expect, test } from 'bun:test'
import { modals } from './modals.ts'
import { picker } from './picker.ts'
import type { Key } from './forms.ts'

const ids = [
	'hal/intro',
	'openrouter/stepfun/step-3.5-flash',
	'openrouter/anthropic/claude-opus-4.5',
	'anthropic/claude-opus-4-5',
	'anthropic/claude-sonnet-4-5',
	'anthropic/claude-opus-5-5',
	'anthropic/claude-opus-5',
	'openrouter/openai/gpt-5.5',
]

test('typing opus-5.5 puts claude-opus-5-5 first, not step-3.5-flash', () => {
	let ranked = picker.rank(ids, 'opus-5.5')
	expect(ranked[0]).toBe('anthropic/claude-opus-5-5')
	expect(ranked).not.toContain('openrouter/stepfun/step-3.5-flash')
})

test('every word of the query must match, in any case and with any separator', () => {
	expect(picker.rank(ids, 'SONNET')).toEqual(['anthropic/claude-sonnet-4-5'])
	expect(picker.rank(ids, 'opus 4 5')).toEqual(expect.arrayContaining(['anthropic/claude-opus-4-5', 'openrouter/anthropic/claude-opus-4.5']))
	expect(picker.rank(ids, 'opus 4 5')).not.toContain('anthropic/claude-opus-5-5')
	expect(picker.rank(ids, 'gemini')).toEqual([])
})

test('whole words rank above parts of words', () => {
	expect(picker.rank(ids, 'opus 5')[0]).toBe('anthropic/claude-opus-5')
	expect(picker.rank(ids, 'gpt5.5')).toEqual(['openrouter/openai/gpt-5.5'])
})

test('an empty query keeps the host order', () => {
	expect(picker.rank(ids, '')).toEqual(ids)
	expect(picker.rank(ids, '  ')).toEqual(ids)
})

const key = (k: string, text?: string): Key => (text === undefined ? { key: k } : { key: k, text })
function type(st: ReturnType<typeof picker.open>, s: string) {
	for (let c of s) st = picker.refilter(modals.step(st, key(c, c)).state, ids)
	return st
}

test('the picker opens on the current model and filters as you type', () => {
	let st = picker.open('anthropic/claude-sonnet-4-5', ids)
	expect(st.items).toEqual(expect.arrayContaining(['anthropic/  (4 models)', '  anthropic/opus  (default: claude-opus-5-5)']))
	expect(st.choices?.[st.items[st.selected]!]).toBe('anthropic/claude-sonnet-4-5')
	expect(st.title).toContain('anthropic/claude-sonnet-4-5')
	st = type(st, 'opus-5.5')
	expect(st.items[st.selected]).toBe('anthropic/claude-opus-5-5')
	let { action } = modals.step(st, key('enter'))
	expect(action?.type === 'submit' && picker.command('s1', st, action)).toEqual({ type: 'submit', sessionId: 's1', text: '/model anthropic/claude-opus-5-5' })
})

test('Enter on a family uses its newest model; grouped models retain their display names', () => {
	let st = picker.open('hal/intro', ids, { 'anthropic/claude-opus-5-5': 'Opus 5.5' })
	let row = st.items.findIndex((item) => item.startsWith('  anthropic/opus  '))
	expect(st.items.some((item) => item.includes('Opus 5.5'))).toBe(true)
	expect(picker.command('s1', st, { type: 'submit', answers: {}, item: row })).toEqual({ type: 'submit', sessionId: 's1', text: '/model anthropic/claude-opus-5-5' })
})

test('Enter with nothing matching switches to nothing', () => {
	let st = type(picker.open('hal/intro', ids), 'zzz')
	expect(st.items).toEqual([])
	let { action } = modals.step(st, key('enter'))
	expect(action?.type === 'submit' && picker.command('s1', st, action)).toBeUndefined()
})
