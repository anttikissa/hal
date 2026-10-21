// The transient find modal shared by terminal and browser (task 6m).
// Focus: 0 the field, 1..filters.length the filters, then the results.
import { findQuery, type FindBatch, type FindFilter, type FindResult } from './find.ts'
import { forms, type Key } from './forms.ts'
import { modals, type ModalState } from './modals.ts'

// `tabs`: the open tabs' session ids in tab order, for the tab numbers.
export type FindDialog = {
	filters: FindFilter[]
	results: FindResult[]
	request?: string
	moved: boolean
	focus: number
	done: boolean
	status: string
	failed?: true
	tabs: string[]
}
const filters: FindFilter[] = ['text', 'thinking', 'tools', 'commit', 'other']
const labels = ['user/assistant', 'thinking', 'tools', 'commits', 'other']
// The results' focus stop, after the field and the filters.
const resultsFocus = filters.length + 1
const question = 'Find anything: text, tab, card, project, whatever'
const recent = 'Showing recent tabs'
function recentLabel(filters: string[]): string {
	return filters.join() === 'commit' ? 'Showing recent commits' : recent
}
const keys = [
	'↓: filters · enter: open · esc: close',
	'←→: move · space: toggle · ↑↓: field/results · esc: close',
	'↑↓: move · enter: open · esc: close',
]

function open(remembered: FindFilter[], tabs: string[] = []): ModalState {
	let m = modals.open({ title: 'Find', form: { text: 'Find', fields: [{ name: 'query', type: 'text' }] } })
	return {
		...m,
		question,
		hint: keys[0],
		find: { filters: [...remembered], results: [], moved: false, focus: 0, done: false, status: recent, tabs },
	}
}
function input(m: ModalState, text: string): ModalState {
	return {
		...m,
		form: forms.set(m.form!, 0, text),
		query: findDialog.words(text),
		selected: 0,
		scroll: 0,
		items: [],
		error: undefined,
		find: {
			...m.find!,
			request: undefined,
			results: [],
			moved: false,
			done: false,
			failed: undefined,
			status: text.trim() ? 'Searching…' : recentLabel(m.find!.filters),
		},
	}
}
function words(text: string): string {
	try {
		return findQuery.parse(text).words.join(' ')
	} catch {
		return ''
	}
}
function toggle(m: ModalState, i: number): ModalState {
	let f = filters[i]!,
		enabled = m.find!.filters,
		next = findDialog.input(m, m.form!.values[0]!)
	return {
		...next,
		find: { ...next.find!, filters: enabled.includes(f) ? enabled.filter((v) => v !== f) : [...enabled, f] },
	}
}
// `m` with focus on `focus` and the footer naming that part's keys.
function focus(m: ModalState, focus: number): ModalState {
	let moved = m.find!.moved || focus === resultsFocus
	return { ...m, hint: keys[focus === 0 ? 0 : focus < resultsFocus ? 1 : 2], find: { ...m.find!, focus, moved } }
}
// Down goes field, filters, results; Up back. Left and Right move among
// the filters, Space or Enter toggles one; Tab cycles every stop.
function step(m: ModalState, k: Key): ReturnType<typeof modals.step> {
	let f = m.find!
	let to = (n: number) => ({ state: findDialog.focus(m, n) })
	if (k.key === 'escape') return { state: m, action: { type: 'cancel' } }
	if (k.key === 'tab') return to((f.focus + (k.shift ? resultsFocus : 1)) % (resultsFocus + 1))
	if (f.focus > 0 && f.focus < resultsFocus) {
		if (k.key === 'left' || k.key === 'right')
			return to(Math.min(filters.length, Math.max(1, f.focus + (k.key === 'left' ? -1 : 1))))
		if (k.key === ' ' || k.key === 'space' || k.key === 'enter') return { state: findDialog.toggle(m, f.focus - 1) }
		if (k.key === 'up') return to(0)
		if (k.key === 'down')
			return m.items.length ? { state: { ...findDialog.focus(m, resultsFocus), selected: 0, scroll: 0 } } : { state: m }
		return { state: m }
	}
	if (f.focus === 0 && (k.key === 'down' || k.key === 'up')) return k.key === 'down' ? to(1) : { state: m }
	if (f.focus === resultsFocus && k.key === 'up' && m.selected === 0) return to(1)
	if (k.key === 'up' || k.key === 'down') {
		let r = modals.step(m, k)
		return { state: { ...r.state, find: { ...f, moved: true } } }
	}
	if (k.key === 'enter') return m.items.length ? modals.step(m, k) : { state: m }
	if (f.focus !== 0) return { state: m }
	let r = modals.step(m, k)
	return {
		state:
			r.state.form!.values[0] !== m.form!.values[0]
				? { ...findDialog.input(m, r.state.form!.values[0]!), form: r.state.form }
				: r.state,
	}
}
function age(ms: number): string {
	return ms < 60000
		? 'now'
		: ms < 3600000
			? `${Math.floor(ms / 60000)}m`
			: ms < 86400000
				? `${Math.floor(ms / 3600000)}h`
				: `${Math.floor(ms / 86400000)}d`
}
// Result rows as aligned columns: tab number (blank for a closed
// session), session/card id, name cut to leave the snippet room, age,
// kind (none for session matches), snippet.
function rows(results: FindResult[], tabs: string[], columns = 120, query = ''): string[] {
	let width = (f: (r: FindResult) => string) => Math.max(0, ...results.map((r) => f(r).length))
	let tab = (r: FindResult) => {
		let n = tabs.indexOf(r.sessionId)
		return n < 0 ? '' : String(n + 1)
	}
	let id = (r: FindResult) => (r.card ? `${r.sessionId}/${r.card}` : r.sessionId)
	let kind = (r: FindResult) => (r.kind === 'metadata' ? '' : `[${r.kind}]`)
	let cut = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + (n ? '…' : '') : s)
	let w = { tab: width(tab), id: width(id), name: 0, age: width((r) => age(r.age)), kind: width(kind) }
	let fixed = [w.tab, w.id, w.age, w.kind].filter(Boolean).reduce((sum, n) => sum + n + 2, 0)
	w.name = Math.min(
		width((r) => r.name),
		Math.max(0, columns - fixed - 62),
	)
	let textWidth = Math.max(1, columns - fixed - (w.name ? w.name + 2 : 0))
	let leadWidth = Math.min(21, Math.max(0, Math.floor(textWidth / 4)))
	let snippet = (r: FindResult) => {
		let at = findDialog.marks(r.snippet, query)[0]?.[0]
		if (at === undefined) return r.snippet.trimStart()
		let lead = r.snippet.slice(0, at).trimStart()
		if (lead.length > leadWidth) lead = leadWidth > 1 ? '…' + lead.slice(-(leadWidth - 1)) : '…'.slice(0, leadWidth)
		return lead.padStart(leadWidth) + r.snippet.slice(at)
	}
	let cells = (r: FindResult) => [
		w.tab && tab(r).padStart(w.tab),
		id(r).padEnd(w.id),
		w.name && cut(r.name, w.name).padEnd(w.name),
		age(r.age).padStart(w.age),
		w.kind && kind(r).padEnd(w.kind),
		snippet(r),
	]
	return results.map((r) =>
		cells(r)
			.filter((c) => c !== 0)
			.join('  '),
	)
}
function batch(m: ModalState, b: FindBatch): ModalState {
	let f = m.find!
	if (b.request !== f.request) return m
	let results = f.results
	if (!b.done) {
		let next = b.results,
			existing = results.filter((r) => r.kind === b.tier)
		if (f.moved) {
			// Keep visible rows in place, even if the host's top-50 changed.
			next = [...existing, ...next.filter((r) => !existing.some((e) => e.href === r.href))]
			results = [...results, ...next.slice(existing.length)]
		} else
			results = [...results.filter((r) => r.kind !== b.tier), ...next].sort(
				(a, c) => c.score - a.score || findQuery.tiers.indexOf(a.kind) - findQuery.tiers.indexOf(c.kind),
			)
	}
	let query = !!m.form!.values[0]!.trim()
	let count = `${results.length} result${results.length === 1 ? '' : 's'}`
	let status = b.error
		? `Find failed: ${b.error}`
		: !query
			? recentLabel(f.filters)
			: b.done
				? results.length
					? `Showing ${count}`
					: 'No results'
				: b.scanning
					? `Showing ${count}, scanning ${b.scanning.toLocaleString()} histories…`
					: `Showing ${count}, searching ${b.tier}…`
	return {
		...m,
		items: findDialog.rows(results, f.tabs),
		find: { ...f, results, done: b.done, status, ...(b.error ? { failed: true as const } : { failed: undefined }) },
	}
}
function marks(text: string, query: string): [number, number][] {
	let lower = text.toLocaleLowerCase(),
		ranges: [number, number][] = []
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
export const findDialog = {
	filters,
	labels,
	resultsFocus,
	question,
	open,
	input,
	toggle,
	focus,
	step,
	words,
	rows,
	batch,
	marks,
}
