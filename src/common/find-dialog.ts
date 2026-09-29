// The transient find modal shared by terminal and browser.
import { findQuery, type FindBatch, type FindFilter, type FindResult } from './find.ts'
import { forms, type Key } from './forms.ts'
import { modals, type ModalState } from './modals.ts'

export type FindDialog = { filters: FindFilter[]; results: FindResult[]; request?: string; moved: boolean; focus: number; done: boolean }
const filters: FindFilter[] = ['text', 'thinking', 'tools', 'other']
const labels = ['user/assistant', 'thinking', 'tools', 'other']
function open(remembered: FindFilter[]): ModalState {
	return { ...modals.open({ title: 'Find', form: { text: 'Find', fields: [{ name: 'query', label: 'Query', type: 'text' }] } }), find: { filters: [...remembered], results: [], moved: false, focus: 0, done: true }, hint: 'Type a query · tab: filters/results · enter: open · esc: close' }
}
function input(m: ModalState, text: string): ModalState {
	return { ...m, form: forms.set(m.form!, 0, text), query: findDialog.words(text), selected: 0, scroll: 0, items: [], find: { ...m.find!, request: undefined, results: [], moved: false, done: false } }
}
function words(text: string): string {
	try { return findQuery.parse(text).words.join(' ') } catch { return '' }
}
function toggle(m: ModalState, i: number): ModalState {
	let f = filters[i]!, enabled = m.find!.filters
	return { ...findDialog.input(m, m.form!.values[0]!), find: { ...m.find!, request: undefined, results: [], moved: false, done: false, filters: enabled.includes(f) ? enabled.filter((v) => v !== f) : [...enabled, f] }, items: [], selected: 0, scroll: 0 }
}
function step(m: ModalState, k: Key): ReturnType<typeof modals.step> {
	let f = m.find!
	if (k.key === 'escape') return { state: m, action: { type: 'cancel' } }
	if (k.key === 'tab') return { state: { ...m, find: { ...f, focus: (f.focus + (k.shift ? 5 : 1)) % 6 } } }
	if ((k.key === ' ' || k.key === 'space') && f.focus > 0 && f.focus < 5) return { state: findDialog.toggle(m, f.focus - 1) }
	if (k.key === 'up' || k.key === 'down') {
		let r = modals.step(m, k)
		return { state: { ...r.state, find: { ...f, moved: true } } }
	}
	if (k.key === 'enter') return m.items.length ? modals.step(m, k) : { state: m }
	if (f.focus !== 0) return { state: m }
	let r = modals.step(m, k)
	return { state: r.state.form!.values[0] !== m.form!.values[0] ? { ...findDialog.input(m, r.state.form!.values[0]!), form: r.state.form } : r.state }
}
function row(r: FindResult): string {
	let age = r.age < 60000 ? 'now' : r.age < 3600000 ? `${Math.floor(r.age / 60000)}m` : r.age < 86400000 ? `${Math.floor(r.age / 3600000)}h` : `${Math.floor(r.age / 86400000)}d`
	return `[${r.kind}] ${r.sessionId} ${r.name} · ${age} · ${r.snippet}`
}
function batch(m: ModalState, b: FindBatch): ModalState {
	let f = m.find!
	if (b.request !== f.request) return m
	let results = f.results
	if (!b.done) {
		let next = b.results, existing = results.filter((r) => r.kind === b.tier)
		if (f.moved) {
			// Keep visible rows in place, even if the host's top-50 changed.
			next = [...existing, ...next.filter((r) => !existing.some((e) => e.href === r.href))]
			results = [...results, ...next.slice(existing.length)]
		} else results = [...results.filter((r) => r.kind !== b.tier), ...next].sort((a, c) => findQuery.tiers.indexOf(a.kind) - findQuery.tiers.indexOf(c.kind) || c.score - a.score)
	}
	return { ...m, items: results.map(findDialog.row), find: { ...f, results, done: b.done }, hint: b.error ?? (b.done ? `${results.length} results · enter: open · esc: close` : b.scanning ? `scanning ${b.scanning.toLocaleString()} histories…` : `searching ${b.tier}…`) }
}
function marks(text: string, query: string): [number, number][] {
	let lower = text.toLocaleLowerCase(), ranges: [number, number][] = []
	for (let word of query.split(/\s+/).filter(Boolean)) {
		for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + 1)) ranges.push([at, at + word.length])
	}
	let out: [number, number][] = []
	for (let r of ranges.sort((a, b) => a[0] - b[0])) {
		let last = out[out.length - 1]
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
		else out.push(r)
	}
	return out
}
export const findDialog = { filters, labels, open, input, toggle, step, words, row, batch, marks }
