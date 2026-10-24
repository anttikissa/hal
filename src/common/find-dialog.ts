// The transient find modal shared by terminal and browser (tasks 6m, yhm).
// Focus: 0 the field, 1..filters.length the filters, then the results.
import { findQuery, type FindBatch, type FindFilter, type FindPreview, type FindResult } from './find.ts'
import { forms, type Key } from './forms.ts'
import { modals, type ModalState } from './modals.ts'

// `tabs`: the open tabs' session ids in tab order, for the tab numbers.
// `here`: the tab Find opened from (in:here). `back`: the query before
// Right listed one tab's cards; Left restores it.
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
	here?: string
	back?: string
	// How many rows the host sends; load more raises it.
	limit: number
	// The last preview that arrived; it stays until the next (task w17).
	preview?: FindPreview
}
const filters = findQuery.filters
const labels = ['user', 'Hal', 'reasoning', 'tools', 'commits', 'other']
// The results' focus stop, after the field and the filters.
const resultsFocus = filters.length + 1
const examples = 'compact in:here · "live file" · rebase -conflict · since:24h'
const question = `Find anything: tab names, requests, commits, tool output\nExamples: ${examples} · /help find for more`
const page = 50
const recent = 'recent tabs'
// The title carries the status; a failure has its own row instead.
function title(status: string, failed?: boolean): string {
	return failed ? 'Find' : `Find · ${status}`
}
const keys = [
	'↓: filters · enter: open · esc: close',
	'←→: move · space: toggle · ↑↓: field/results · esc: close',
	'↑↓: move · →: cards · enter: open · esc: close',
	'↑↓: move · ←: tabs · enter: open · esc: close',
]

function open(remembered: FindFilter[], tabs: string[] = [], here?: string): ModalState {
	let m = modals.open({ title: title(recent), form: { text: 'Find', fields: [{ name: 'query', type: 'text' }] } })
	return {
		...m,
		question,
		hint: keys[0],
		find: {
			filters: [...remembered],
			results: [],
			moved: false,
			focus: 0,
			done: false,
			status: recent,
			tabs,
			here,
			limit: page,
		},
	}
}
function input(m: ModalState, text: string): ModalState {
	let status = text.trim() ? m.find!.status : recent
	return {
		...m,
		title: title(status),
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
			limit: page,
			status,
		},
	}
}
// Load more: `m` asking for the next page once a finished search filled
// its limit and the view `near`s the end; undefined otherwise.
function more(m: ModalState, near: boolean): ModalState | undefined {
	let f = m.find!
	if (!near || !f.done || f.failed || !f.request || f.results.length < f.limit) return
	return { ...m, find: { ...f, done: false, limit: f.limit + page } }
}
// The selection is in the last rows of the results.
function near(m: ModalState): boolean {
	return m.find!.focus === resultsFocus && m.selected >= m.items.length - 10
}
function words(text: string): string {
	try {
		let q = findQuery.parse(text)
		return [...q.words, ...q.phrases].join(' ')
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
	let hint = focus === 0 ? 0 : focus < resultsFocus ? 1 : m.find!.back !== undefined ? 3 : 2
	return { ...m, hint: keys[hint], find: { ...m.find!, focus, moved } }
}
// The query listing one tab's cards: its in: tab values replaced by `id`,
// kind values kept.
function scoped(text: string, id: string): string {
	let kinds = new Set<string>(findQuery.filters)
	let rest = text
		.trim()
		.split(/\s+/)
		.flatMap((w) => {
			let m = /^in:(.*)$/i.exec(w)
			if (!m) return [w]
			let kept = m[1]!.split(',').filter((v) => kinds.has(v.toLowerCase()))
			return kept.length ? [`in:${kept.join(',')}`] : []
		})
	return [...rest.filter(Boolean), `in:${id}`].join(' ')
}
// `m` with query `text`, keeping the focus on the results.
function requery(m: ModalState, text: string, back: string | undefined): ModalState {
	let next = findDialog.focus(findDialog.input(m, text), resultsFocus)
	return { ...next, find: { ...next.find!, back, moved: false } }
}
// Down goes field, filters, results; Up back. Left and Right move among
// the filters, Space or Enter toggles one; Tab cycles every stop. In the
// results Right lists the selected tab's cards and Left goes back.
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
	if (f.focus === resultsFocus) {
		let text = m.form!.values[0]!,
			row = f.results[m.selected]
		if (k.key === 'up' && m.selected === 0) return to(1)
		if (k.key === 'right' && row?.count)
			return { state: findDialog.requery(m, findDialog.scoped(text, row.sessionId), f.back ?? text) }
		if (k.key === 'left' && f.back !== undefined) return { state: findDialog.requery(m, f.back, undefined) }
	}
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
// `r`'s snippet with at most `leadWidth` characters before its first
// match, padded so matches line up across rows.
function snippet(r: FindResult, query: string, leadWidth: number): string {
	let at = findDialog.marks(r.snippet, query)[0]?.[0]
	if (at === undefined) return r.snippet.trimStart()
	let lead = r.snippet.slice(0, at).trimStart()
	if (lead.length > leadWidth) lead = leadWidth > 1 ? '…' + lead.slice(-(leadWidth - 1)) : '…'.slice(0, leadWidth)
	return lead.padStart(leadWidth) + r.snippet.slice(at)
}
// Result rows as aligned columns: tab number (blank for a closed
// session), session id (card rows: session/card), name, age, why label,
// snippet. A narrow list (beside the preview) keeps up to 32 columns of
// name and shortens the snippet; the preview shows the whole match.
function rows(results: FindResult[], tabs: string[], columns = 120, query = ''): string[] {
	let width = (f: (r: FindResult) => string) => Math.max(0, ...results.map((r) => f(r).length))
	let tab = (r: FindResult) => {
		let n = tabs.indexOf(r.sessionId)
		return n < 0 ? '' : String(n + 1)
	}
	let id = (r: FindResult) => (r.card && !r.count ? `${r.sessionId}/${r.card}` : r.sessionId)
	let cut = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + (n ? '…' : '') : s)
	// A long directory keeps its end, the part that tells tabs apart.
	let dir = (r: FindResult) => (r.cwd.length > 24 ? '…' + r.cwd.slice(-23) : r.cwd)
	let w = {
		tab: width(tab),
		id: width(id),
		name: 0,
		dir: width(dir),
		age: width((r) => age(r.age)),
		why: width((r) => r.why),
	}
	let fixed = [w.tab, w.id, w.dir, w.age, w.why].filter(Boolean).reduce((sum, n) => sum + n + 2, 0)
	w.name = Math.min(
		width((r) => r.name),
		Math.max(0, columns - fixed - 62, Math.min(32, columns - fixed - 24)),
	)
	let textWidth = Math.max(1, columns - fixed - (w.name ? w.name + 2 : 0))
	let leadWidth = Math.min(21, Math.max(0, Math.floor(textWidth / 4)))
	let cells = (r: FindResult) => [
		w.tab && tab(r).padStart(w.tab),
		id(r).padEnd(w.id),
		w.name && cut(r.name, w.name).padEnd(w.name),
		w.dir && dir(r).padEnd(w.dir),
		age(r.age).padStart(w.age),
		w.why && r.why.padEnd(w.why),
		findDialog.snippet(r, query, leadWidth),
	]
	return results.map((r) =>
		cells(r)
			.filter((c) => c !== 0)
			.join('  '),
	)
}
// Each batch carries the whole ranking so far. Until the selection moves
// it replaces the rows; after that rows stay put and unseen ones append.
function batch(m: ModalState, b: FindBatch): ModalState {
	let f = m.find!
	if (b.request !== f.request) return m
	let results = f.results
	if (!b.done) {
		let key = (r: FindResult) => (r.count ? r.sessionId : `${r.href} ${r.kind}`)
		if (f.moved) {
			let seen = new Set(results.map(key))
			results = [...results, ...b.results.filter((r) => !seen.has(key(r)))]
		} else results = b.results
	}
	let query = !!m.form!.values[0]!.trim()
	let noun = results[0]?.count ? 'tab' : 'card'
	let count = `${results.length} ${noun}${results.length === 1 ? '' : 's'}`
	// Batches arrive within milliseconds, so the title keeps its last
	// settled text until the search ends; only a slow index scan shows.
	let status = b.error
		? `Find failed: ${b.error}`
		: !query
			? recent
			: b.done
				? results.length
					? count
					: 'No results'
				: b.scanning
					? `scanning ${b.scanning.toLocaleString()} histories…`
					: f.status
	// Restores the focused part's key hint over "searching…".
	return {
		...findDialog.focus(m, f.focus),
		title: title(status, !!b.error),
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
	examples,
	resultsFocus,
	question,
	open,
	input,
	toggle,
	focus,
	step,
	words,
	near,
	more,
	scoped,
	requery,
	rows,
	snippet,
	age,
	batch,
	marks,
}
