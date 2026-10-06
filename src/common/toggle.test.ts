import { expect, test } from 'bun:test'
import { blocksDialog } from './blocks-dialog.ts'
import { toggle, type Fold } from './toggle.ts'
import type { Item } from './transcript.ts'

const items = [
	{ type: 'prompt', key: '10', text: 'see [paste/abc123.txt]' },
	{ type: 'thinking', key: '11', text: 'hmm' },
	{ type: 'text', key: '12', text: 'answer' },
	{ type: 'prompt', key: '13', text: 'hi', from: 'other', summary: 'Hi' },
	{ type: 'tool', key: '14', id: 'a', name: 'bash', input: {} },
	{ type: 'tool-result', key: '15', id: 'a', output: 'x' },
	{ type: 'tool', key: '16', id: 'b', name: 'bash', input: {} },
	{ type: 'thinking', key: '17', text: 'more' },
] as Item[]
const keys = (args: string, mode: 'toggle' | 'expand' | 'collapse' = 'toggle') => {
	let p = toggle.plan(mode, items, args, toggle.initial)
	return typeof p === 'string' ? p : p.items.map((i) => i.key)
}

test('targets: lists, kinds, ranges and * leave user and assistant blocks alone unless named', () => {
	expect(keys('r11,t16,t11-17')).toEqual(keys('#r11 16  t11 - 17'))
	for (let t of ['#t12', 't12', '12', 'r12']) expect(keys(t)).toEqual(['12'])
	expect(keys('10-17')).toEqual(['11', '13', '14', '16', '17'])
	expect(keys('au10-17')).toEqual(['10', '12'])
	expect(keys('t*')).toEqual(['14', '16'])
	expect(keys('r*, 14')).toEqual(['11', '14', '17'])
	expect(keys('')).toEqual(['16'])
	expect(keys('x*')).toBe('unknown kind x in x* (kinds: t r a u m s q)')
	expect(keys('15')).toBe('block 15 does not expand or collapse')
	expect(keys('18', 'expand')).toBe('no block 18 to expand')
	expect(keys('q*')).toBe('nothing to toggle in q*')
})

test('/toggle steps one named block and applies the majority rule to more; a tie expands', () => {
	let states = new Map<string, Fold>()
	expect(toggle.apply('toggle', states, items, 't*')).toEqual(['14', '16'])
	expect([states.get('14'), states.get('16')]).toEqual(['open', 'open'])
	states.set('16', 'closed')
	toggle.apply('toggle', states, items, 't*')
	expect([states.get('14'), states.get('16')]).toEqual(['open', 'open'])
	toggle.apply('toggle', states, items, 'r*')
	expect([states.get('11'), states.get('17')]).toEqual(['closed', 'closed'])
	toggle.apply('collapse', states, items, '10-17')
	expect(states.get('14')).toBe('closed')
	let steps = [1, 2, 3].map(() => (toggle.apply('toggle', states, items, '#u10'), states.get('10')))
	expect(steps).toEqual(['inline', 'closed', 'open'])
	toggle.apply('expand', states, items, 'u10')
	expect(states.get('10')).toBe('open')
})

test('the dialog hints what Enter does and Tab completes the block id under the cursor', () => {
	let m = blocksDialog.open()
	let typed = (text: string) => blocksDialog.update({ ...m, form: { ...m.form!, values: [text], cursor: text.length } }, items, toggle.initial)
	expect(typed('t*').blocks).toEqual({ hint: 'Expands 2 tool blocks: t14, t16' })
	expect(typed('').blocks).toEqual({ hint: 'Expands tool block t16' })
	expect(typed('t1,').blocks?.invalid).toBe(true)
	let tab = (text: string) => blocksDialog.complete(typed(text), items, toggle.initial)
	expect(tab('r').form!.values[0]).toBe('r1')
	expect(tab('r').blocks?.choices).toEqual(['r17', 'r11'])
	expect(tab('r1').blocks?.choices).toEqual(['r17', 'r11'])
	expect(tab('t14, #r17-1').form!.values[0]).toBe('t14, #r17-1')
	expect(tab('t14 #r1').form!.values[0]).toBe('t14 #r1')
	expect(tab('t14 a').form!.values[0]).toBe('t14 a12')
	expect(blocksDialog.pack(['t1', 't2', 't3', 't4', 't5'], 18, 2)).toEqual(['t1       t2', 't3       +2 more'])
})
