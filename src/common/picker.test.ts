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
const tree = [...ids, 'openai/gpt-6-terra', 'openai/gpt-6-sol', 'openai/gpt-5.5', 'openrouter/moonshotai/kimi-k2']
function type(st: ReturnType<typeof picker.open>, s: string) {
	for (let c of s) st = picker.step(st, key(c, c), tree).state
	return st
}
const press = (st: ReturnType<typeof picker.open>, k: Key) => picker.step(st, k, tree).state
const enter = (st: ReturnType<typeof picker.open>) => {
	let { action } = modals.step(st, key('enter'))
	return action?.type === 'submit' ? picker.command('s1', st, action)?.text : undefined
}
const selected = (st: ReturnType<typeof picker.open>) => st.items[st.selected]!.trim()

test('the picker opens as a tree on the current model, its categories open', () => {
	let st = picker.open('anthropic/claude-sonnet-4-5', tree, { 'anthropic/claude-opus-5-5': 'Opus 5.5' })
	expect(st.title).toContain('anthropic/claude-sonnet-4-5')
	expect(st.items.map((r) => r.trim().split('  ')[0])).toEqual(['▶ hal', '▶ openai', '▼ anthropic', '▶ opus', '* claude-sonnet-4-5 anthropic/claude-sonnet-4-5', '▶ openrouter'])
	expect(selected(st)).toContain('anthropic/claude-sonnet-4-5')
	expect(enter(st)).toBe('/model anthropic/claude-sonnet-4-5')
})

test('typing a family selects its category, and Enter there picks its default', () => {
	let st = picker.open('hal/intro', tree)
	let gpt = type(st, 'gp')
	expect(selected(gpt)).toMatch(/^▼ gpt/)
	expect(enter(gpt)).toBe('/model openai/gpt-6-sol')
	let opus = type(st, 'opus')
	expect(selected(opus)).toMatch(/^▼ opus/)
	expect(enter(opus)).toBe('/model anthropic/claude-opus-5-5')
	// A provider defaults through its alias; a reseller's vendor to its newest.
	expect(enter(type(st, 'anthropic'))).toBe('/model anthropic/claude-opus-5-5')
	expect(enter(type(st, 'moonshot'))).toBe('/model openrouter/moonshotai/kimi-k2')
})

test('typing a model selects the best match, shown in its open categories', () => {
	let st = type(picker.open('hal/intro', tree), 'opus-5.5')
	expect(selected(st)).toMatch(/anthropic\/claude-opus-5-5$/)
	expect(st.items.filter((r) => r.includes('▼')).length).toBeGreaterThan(0)
	expect(enter(st)).toBe('/model anthropic/claude-opus-5-5')
	// Ctrl-U empties the search: the tree and the current model are back.
	st = press(st, { key: 'u', ctrl: true })
	expect(st.form?.values[0]).toBe('')
	expect(selected(st)).toMatch(/hal\/intro$/)
})

test('right opens a category, left closes it or the one the selection is in', () => {
	let st = picker.open('anthropic/claude-opus-5', tree)
	expect(selected(st)).toMatch(/anthropic\/claude-opus-5$/)
	st = press(st, key('left'))
	expect(selected(st)).toMatch(/^▶ opus/)
	st = press(st, key('left'))
	expect(selected(st)).toMatch(/^▶ anthropic/)
	st = press(press(st, key('up')), key('right'))
	expect(st.items.map((r) => r.trim().split('  ')[0])).toEqual(['▶ hal', '▼ openai', '▶ gpt', '▶ anthropic', '▶ openrouter'])
	// Enter on a category without a default opens it instead.
	st = press(press(st, key('up')), key('enter'))
	expect(st.items.some((r) => r.includes('hal/intro'))).toBe(true)
})

test('Enter with nothing matching switches to nothing', () => {
	let st = type(picker.open('hal/intro', tree), 'zzz')
	expect(st.items).toEqual([])
	expect(enter(st)).toBeUndefined()
})
