// Shared card selection and completion contracts across terminal and web.
import { expect, test } from 'bun:test'
import { blocksDialog } from './blocks-dialog.ts'
import type { SessionMeta } from './session.ts'
import { toggle, type Fold } from './toggle.ts'
import { transcript, type Item } from './transcript.ts'

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
const start = toggle.starts({ items, meta: {} as SessionMeta })
const keys = (args: string, mode: 'toggle' | 'expand' | 'collapse' = 'toggle') => {
	let p = toggle.plan(mode, items, args, start)
	return typeof p === 'string' ? p : p.items.map((i) => i.key)
}

test('targets: lists, kinds, ranges and * leave user and assistant blocks alone unless named', () => {
	expect(keys('r11,t16,t11-17')).toEqual(keys('#r11 16  t11 - 17'))
	for (let t of ['#t12', 't12', '12', 'r12']) expect(keys(t)).toEqual(['12'])
	expect(keys('10-17')).toEqual(['11', '13', '14', '16', '17'])
	expect(keys('au10-17')).toEqual(['10', '12'])
	expect(keys('t*')).toEqual(['14', '16'])
	for (let kind of ['t', 'r', 'a', 'u', 'm']) expect(keys(kind)).toEqual(keys(`${kind}*`))
	for (let kind of ['s', 'q']) expect(keys(kind)).toBe(`Nothing to toggle in ${kind}`)
	expect(keys('au')).toEqual(['10', '12'])
	expect(keys('#t, r')).toEqual(keys('t*, r*'))
	expect(keys('x')).toBe('Unknown kind x in x (kinds: t r a u m s q)')
	for (let bad of ['#', 't-', '-t']) expect(keys(bad)).toBe(`Not a card, range or kind: ${bad}`)
	expect(keys('r*, 14')).toEqual(['11', '14', '17'])
	expect(keys('')).toEqual(['16'])
	expect(keys('x*')).toBe('Unknown kind x in x* (kinds: t r a u m s q)')
	expect(keys('15')).toBe('Card 15 does not expand or collapse')
	expect(keys('18', 'expand')).toBe('No card 18 to expand')
	expect(keys('q*')).toBe('Nothing to toggle in q*')
})

test('one named block steps short, glimpse, long (inline); more go long while most are not, else short', () => {
	let states = new Map<string, Fold>()
	expect(toggle.apply('toggle', states, items, 't*', start)).toEqual(['14', '16'])
	expect([states.get('14'), states.get('16')]).toEqual(['long', 'long'])
	states.set('16', 'glimpse')
	toggle.apply('toggle', states, items, 't*', start)
	expect([states.get('14'), states.get('16')]).toEqual(['long', 'long'])
	toggle.apply('toggle', states, items, 't*', start)
	expect([states.get('14'), states.get('16')]).toEqual(['short', 'short'])
	toggle.apply('collapse', states, items, '10-17', start)
	expect(states.get('11')).toBe('short')
	let steps = [1, 2, 3, 4].map(() => (toggle.apply('toggle', states, items, '#u10', start), states.get('10')))
	expect(steps).toEqual(['inline', 'short', 'glimpse', 'long'])
	toggle.apply('expand', states, items, 'u10', start)
	expect(states.get('10')).toBe('long')
})

test('blocks start as the session sets their kind, over the settings; a failed call as failed', () => {
	let failed = [...items.slice(0, 5), { type: 'tool-result', key: '15', id: 'a', output: 'x', isError: true }] as Item[]
	let at = toggle.starts({ items: failed, meta: { blocks: { thinking: 'long', prompt: 'glimpse' } } as SessionMeta })
	expect(failed.map((i) => at(i))).toEqual(['glimpse', 'long', 'long', 'glimpse', 'glimpse', 'long'])
})

test('the dialog hints what Enter does and Tab completes the block id under the cursor', () => {
	let m = blocksDialog.open()
	let typed = (text: string) => blocksDialog.update({ ...m, form: { ...m.form!, values: [text], cursor: text.length } }, items, start)
	expect(typed('t*').blocks?.hint).toBe('Expand 2 tool cards: t14, t16')
	expect(typed('t').blocks?.hint).toBe(typed('t*').blocks?.hint)
	expect(typed('').blocks?.hint).toBe('Show a glimpse of tool card t16')
	expect(typed('t1,').blocks?.invalid).toBe(true)
	let tab = (text: string) => blocksDialog.complete(typed(text), items, start)
	expect(tab('r').form!.values[0]).toBe('r1')
	expect(tab('r').blocks?.choices).toEqual(['r17', 'r11'])
	expect(tab('r1').blocks?.choices).toEqual(['r17', 'r11'])
	expect(tab('t14, #r17-1').form!.values[0]).toBe('t14, #r17-1')
	expect(tab('t14 #r1').form!.values[0]).toBe('t14 #r1')
	expect(tab('t14 a').form!.values[0]).toBe('t14 a12')
	expect(blocksDialog.pack(['t1', 't2', 't3', 't4', 't5'], 18, 2)).toEqual(['t1       t2', 't3       +2 more'])
})

test('queued inbox blocks share targeting, defaults and expansion with history', () => {
	let all = toggle.items({ items, inbox: [{ id: 'queued', n: 20, text: 'First\nLast', from: 'other', delivery: 'after-turn' }] })
	let states = new Map<string, Fold>()
	let at = toggle.starts({ items: all, meta: {} as SessionMeta })
	expect(at(all.at(-1)!)).toBe('short')
	expect(toggle.apply('toggle', states, all, '#m20', at)).toEqual(['20'])
	expect(states.get('20')).toBe('long')
	let dialog = blocksDialog.open()
	dialog.form!.values[0] = 'm20'
	expect(blocksDialog.update(dialog, all, (i) => states.get(i.key) ?? at(i)).blocks?.hint).toContain('Collapse')
	toggle.apply('collapse', states, all, 'm*', at)
	expect(states.get('20')).toBe('short')
})

test('range expansion preserves inline detail and web hints respect native paste links', () => {
	let item = items[0]!
	expect(toggle.step(item, 'inline', true)).toBe('inline')
	expect(toggle.step(item, 'long', undefined, false)).toBe('short')
	let dialog = blocksDialog.open()
	dialog.form!.values[0] = item.key
	expect(blocksDialog.update(dialog, items, () => 'long', false).blocks?.hint).toContain('Collapse')
})

test('completion and opening share exact card keys, including extra items', () => {
	let commit = transcript.commitItem({ hash: 'abc123', short: 'abc123', subject: 'Fix', files: [] })
	let all = [...items, ...['18.1', '18.10', '18.2'].map((key) => ({ ...commit, key })), { type: 'output', key: '19.1', text: 'plain output' } as Item]
	let at = () => 'short' as Fold
	let selected = (args: string) => {
		let p = toggle.plan('expand', all, args, at)
		return typeof p === 'string' ? p : p.items.map((i) => i.key)
	}
	let tab = (text: string) => {
		let m = blocksDialog.open()
		return blocksDialog.complete({ ...m, form: { ...m.form!, values: [text], cursor: text.length } }, all, at)
	}
	for (let item of all.filter(toggle.toggles)) {
		let completed = tab(item.key).form!.values[0]!
		expect(selected(completed)).toEqual([item.key])
	}
	let choices = tab('#s18.').blocks!.choices!
	expect(choices).toEqual(['s18.2', 's18.10', 's18.1'])
	for (let id of choices) expect(selected(id)).toEqual([id.slice(1)])
	expect(tab('t14, #s18.2').form!.values[0]).toBe('t14, #s18.2')
	expect(tab('s18.1-18.2').form!.values[0]).toBe('s18.1-18.2')
	expect(selected('s*')).toEqual(['18.1', '18.10', '18.2'])
	expect(selected('18-18')).toEqual(['18.1', '18.10', '18.2'])
	expect(selected('s18.2-18.10')).toEqual(['18.10', '18.2'])
	expect(selected('s18.10-18.2')).toEqual(['18.10', '18.2'])
	expect(selected('#t18.2, 18.10')).toEqual(['18.10', '18.2'])
	let states = new Map<string, Fold>()
	expect(toggle.apply('expand', states, all, '#s18.1', at)).toEqual(['18.1'])
	expect(states.get('18.1')).toBe('long')
	let middle = tab('#s18.2, t14')
	middle.form!.values[0] = '#s18.2, t14'
	expect(blocksDialog.complete(middle, all, at, 6).form!.values[0]).toBe('#s18.2, t14')
	expect(selected('19.1')).toBe('Card 19.1 does not expand or collapse')
	for (let bad of ['18.', '18..1', '18.1.2', '18-19-20']) expect(selected(bad)).toBe(`Not a card, range or kind: ${bad}`)
})
