import type { EffortCapability } from './effort.ts'
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
	expect(st.items.map((r) => r.trim().split('  ')[0])).toEqual(['▶ hal', '▶ openai', '▼ anthropic', '▶ opus', '✓ anthropic/claude-sonnet-4-5', '▶ openrouter'])
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

test('right opens a category, left closes it or moves from a closed category to its parent', () => {
	let st = picker.open('anthropic/claude-opus-5', tree)
	expect(selected(st)).toMatch(/anthropic\/claude-opus-5$/)
	st = press(st, key('left'))
	expect(selected(st)).toMatch(/anthropic\/claude-opus-5$/)
	st = press(st, key('up'))
	st = press(st, key('up'))
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

test('families go most capable first, and equal matches select an alias model, else the higher row', () => {
	let all = [...tree, 'anthropic/claude-haiku-4-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-fable-5', 'anthropic/claude-fable-5-1', 'openai/gpt-6-luna']
	let st = picker.open('hal/intro', all)
	st = picker.refilter({ ...st, tree: { ...st.tree!, open: ['anthropic', 'openai', 'openai/gpt'] } }, all)
	expect(st.items.map((r) => r.trim().split('  ')[0]!).filter((r) => /^▶ (fable|opus|sonnet)$/.test(r))).toEqual(['▶ fable', '▶ opus', '▶ sonnet'])
	let gpt = st.items.filter((r) => r.includes('openai/gpt-')).map((r) => r.split('openai/')[1])
	expect(gpt).toEqual(['gpt-6-sol', 'gpt-6-terra', 'gpt-6-luna', 'gpt-5.5'])
	expect(enter(picker.step(st, key('c', 'clau'), all).state)).toBe('/model anthropic/claude-opus-5-5')
	expect(enter(picker.step(st, key('s', 'sonnet 5'), all).state)).toBe('/model anthropic/claude-sonnet-5')
})

test('dated snapshots hide; versions past a family two newest wait under older', () => {
	let all = ['anthropic/claude-opus-5-5', 'anthropic/claude-opus-4-5', 'anthropic/claude-opus-4-5-20251101', 'anthropic/claude-opus-4-1', 'anthropic/claude-haiku-3-20240307']
	let shown = (current: string, open: string[]) => picker.refilter({ ...picker.open(current, all), tree: { rows: [], open, current } }, all).items.join('\n')
	let closed = shown('hal/intro', ['anthropic', 'anthropic/opus'])
	expect(closed).toMatch(/claude-opus-4-5$/m)
	expect(closed).not.toMatch(/20251101|opus-4-1/)
	expect(closed).toMatch(/▶ older$/m)
	expect(shown('hal/intro', ['anthropic', 'anthropic/opus', 'anthropic/opus/older'])).toMatch(/claude-opus-4-1$/m)
	// A snapshot alone stays; the current model's categories open.
	expect(closed).toContain('claude-haiku-3-20240307')
	expect(picker.open('anthropic/claude-opus-4-1', all).items.join('\n')).toMatch(/✓ anthropic\/claude-opus-4-1$/m)
})

test('a family lists its flagships; variants and non-chat models wait in closed buckets, last', () => {
	let all = ['openai/gpt-6-sol', 'openai/gpt-6-luna', 'openai/gpt-5.6-sol', 'openai/gpt-5.5', 'openai/gpt-6-mini', 'openai/gpt-daybreak-blue-latest', 'openai/gpt-image-2', 'openai/gpt-realtime-2.1', 'openai/o3', 'openai/text-embedding-3-large']
	let st = picker.open('openai/gpt-6-sol', all)
	let text = st.items.join('\n')
	expect(text).toMatch(/gpt-6-luna$/m)
	expect(text).toMatch(/gpt-5\.6-sol$/m)
	expect(text).not.toMatch(/gpt-5\.5$|mini|daybreak|image|realtime|o3|embedding/m)
	expect(st.items.findIndex((r) => r.trim() === '▶ older')).toBeGreaterThan(st.items.findIndex((r) => r.endsWith('gpt-5.6-sol')))
	expect(st.items.at(-1)!.trim()).toBe('▶ other')
	// A bucket has no default: Enter opens it.
	let other = picker.refilter({ ...st, selected: st.items.length - 1 }, all)
	other = picker.step({ ...other, selected: other.items.length - 1 }, key('enter'), all).state
	expect(other.items.join('\n')).toMatch(/gpt-image-2$/m)
	expect(other.items.join('\n')).toMatch(/openai\/o3$/m)
	// Searching reaches them.
	expect(enter(picker.step(st, key('d', 'daybreak'), all).state)).toBe('/model openai/gpt-daybreak-blue-latest')
})

test('left and right open and close categories while searching too', () => {
	let st = type(picker.open('hal/intro', tree), 'opus')
	expect(selected(st)).toMatch(/opus/)
	let closed = press(st, key('left'))
	expect(closed.form?.values[0]).toBe('opus')
	expect(selected(closed)).toMatch(/▶ opus/)
	expect(selected(press(closed, key('right')))).toMatch(/▼ opus/)
})

test('searching opens a family but keeps its older closed, unless only older matches', () => {
	let all = ['openai/gpt-6-sol', 'openai/gpt-6-luna', 'openai/gpt-5.6-sol', 'openai/gpt-5.5', 'openai/gpt-image-2', 'anthropic/claude-opus-5-5']
	let search = (q: string) => picker.step(picker.open('anthropic/claude-opus-5-5', all), key('x', q), all).state
	let gpt = search('gpt').items.join('\n')
	expect(gpt).toMatch(/▼ gpt/)
	expect(gpt).toMatch(/gpt-6-sol$/m)
	expect(gpt).toMatch(/▶ older$/m)
	expect(gpt).toMatch(/▶ other$/m)
	expect(gpt).not.toMatch(/gpt-5\.5$|gpt-image-2$/m)
	let old = search('gpt 5.5')
	expect(old.items.join('\n')).toMatch(/▼ older$/m)
	expect(enter(old)).toBe('/model openai/gpt-5.5')
	// Right opens a closed bucket while searching; left closes it again.
	let at = picker.refilter({ ...search('gpt'), selected: 0 }, all)
	at = { ...at, selected: at.items.findIndex((r) => r.trim() === '▶ older') }
	let opened = picker.step(at, key('right'), all).state
	expect(opened.items.join('\n')).toMatch(/gpt-5\.5$/m)
	expect(picker.step(opened, key('left'), all).state.items.join('\n')).not.toMatch(/gpt-5\.5$/m)
})


test('effort drafts clamp on leaves, preserve tags and filtering, keep row identity, and commit only on Enter', () => {
	let ids = ['ollama/gpt-oss:20b', 'openai/gpt-6-sol', 'hal/intro']
	let capabilities: Record<string, EffortCapability> = {
		[ids[0]!]: { levels: ['low', 'medium', 'high'], default: 'medium' },
		[ids[1]!]: { levels: ['none', 'low', 'high', 'max'] },
	}
	let st = picker.open(ids[0]!, ids, {}, capabilities, 'high')
	let row = st.tree!.rows[st.selected]
	st = picker.step(st, key('right'), ids).state
	expect(picker.label(st, ids[0]!)).toBe('high')
	st = picker.step(st, key('left'), ids).state
	expect(picker.label(st, ids[0]!)).toBe('default (medium)')
	expect(st.items[st.selected]).toEndWith('‹ default (medium) ›')
	expect(st.tree!.rows[st.selected]).toBe(row)
	st = picker.step(st, key('x', 'gpt-oss'), ids).state
	st = picker.refilter(st, ids, {}, ids[0])
	st = picker.step(st, key('left'), ids).state
	st = picker.step(st, key('left'), ids).state
	expect(picker.label(st, ids[0]!)).toBe('low')
	// One draft for the whole picker: another model shows its nearest
	// level, only the selected row shows effort, hints follow the row.
	expect(picker.label(st, ids[1]!)).toBe('low')
	expect(st.items.filter((t) => t.includes('‹'))).toEqual([st.items[st.selected]!])
	expect(st.hint).toBe('←/→: lower/higher effort, enter: pick, esc: cancel')
	let cancel = picker.step(st, key('escape'), ids)
	expect(cancel.action).toEqual({ type: 'cancel' })
	let submit = picker.step(st, key('enter'), ids)
	expect(picker.command('s', submit.state, submit.action as any)?.text).toBe('/model ollama/gpt-oss:20b:low')
	let unknown = picker.open(ids[1]!, ids, {}, capabilities)
	expect(picker.label(unknown, ids[1]!)).toBe('default')
	expect(picker.label(picker.step(unknown, key('right'), ids).state, ids[1]!)).toBe('none')
	expect(picker.label(picker.step(unknown, key('left'), ids).state, ids[1]!)).toBe('max')
	let unsupported = picker.open('hal/intro', ids, {}, capabilities)
	expect(picker.step(unsupported, key('left'), ids).state).toBe(unsupported)
	expect(picker.label(unsupported, 'hal/intro')).toBe('')
})

// Exercise navigation, not just refilter: Up/Down used to move the
// cursor without updating the help, title or effort marker (task r7r).
test('moving rows keeps hints, effort, names and category defaults tied to the highlighted choice', () => {
	let gpt = 'openai/gpt-6.1-sol', opus = 'anthropic/claude-opus-5-5', haiku = 'anthropic/claude-haiku-4-5-20251001'
	let all = [gpt, 'openai/gpt-6-astra', opus, 'anthropic/claude-opus-5', haiku]
	let names = { [gpt]: 'GPT-6.1 Sol', [opus]: 'Claude Opus 5.5', [haiku]: 'Claude Haiku 4.5' }
	let capabilities: Record<string, EffortCapability> = { [gpt]: { levels: ['low', 'medium', 'high'], default: 'medium' }, [opus]: { levels: ['low', 'medium', 'high'], default: 'medium' }, 'anthropic/claude-opus-5': { levels: ['low', 'medium', 'high'], default: 'medium' } }
	let st = picker.open(opus, all, names, capabilities, 'high')
	let move = (direction: string) => { st = picker.step(st, key(direction), all, names).state }
	let chosen = () => st.tree!.rows[st.selected]!
	let marked = () => st.items.filter((s) => s.includes('‹'))
	expect(marked()).toEqual([st.items[st.selected]!])
	expect(st.values?.[st.selected]).toBe(names[opus])
	move('up')
	expect(chosen().path).toBe('anthropic/opus')
	expect(st.hint).toBe('←/→: close/open, enter: pick default, esc: cancel')
	expect(marked()).toEqual([])
	move('down')
	expect(st.hint).toBe('←/→: lower/higher effort, enter: pick, esc: cancel')
	expect(marked()).toEqual([st.items[st.selected]!])
	move('down')
	expect(st.title).toBe('Model: anthropic/claude-opus-5:high')
	move('down')
	expect(chosen().id).toBe(haiku)
	expect(st.items[st.selected]!.trim()).toBe('Haiku 4.5')
	expect(st.values?.[st.selected]).toBe('')
	expect(st.title).toBe(`Model: ${haiku}`)
	expect(st.hint).toBe('enter: pick, esc: cancel')
	expect(marked()).toEqual([])
	// The closed provider still tells you what Enter picks.
	while (st.selected > 0) move('up')
	expect(chosen().path).toBe('openai')
	expect(st.items[st.selected]).toContain(`default: ${names[gpt]}`)
	expect(st.title).toBe(`Model: ${gpt}:high`)
	expect(st.hint).toContain('enter: pick default')
	expect(enter(st)).toBe(`/model ${gpt}:high`)
})
