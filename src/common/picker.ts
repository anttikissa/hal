// The model picker (tasks/w4/forms.md, Model picker): a modal with a
// search box over a tree of the host's model ids, like the old Hal's:
// provider, then family or vendor, then models. ▶ and ▼ mark closed and
// open categories; right and left open and close them. A category Enter
// picks its default model. Typing filters and ranks the models, opens
// the categories that hold them and selects the best match, a matching
// category first (typing "gp" selects openai/gpt). Enter ends in an
// ordinary command, `/model <id>`. Shared by terminal and web; the list
// itself comes from the host (the `models` event).

import { forms, type Key } from './forms.ts'
import type { ModalAction, ModalState, TreeRow } from './modals.ts'
import { fuzzy } from './fuzzy.ts'
import { titles } from './titles.ts'
import { modals } from './modals.ts'
import { effortLevels, type EffortCapability, type EffortLevel } from './effort-levels.ts'
import { modelAliases } from './model-aliases.ts'
import { modelTree, type Node } from './model-tree.ts'

// The ids matching `query`, best first; ties keep the given order,
// shorter ids first. An empty query keeps every id in order. An id's
// display name in `names` matches too, after the id itself.
function rank(ids: string[], query: string, names: Record<string, string> = {}): string[] {
	let q = fuzzy.words(query)
	if (!q.length) return ids
	let scored: { id: string; score: number; i: number }[] = []
	ids.forEach((id, i) => {
		let s = fuzzy.score(names[id] ? `${id} ${names[id]}` : id, q)
		if (s !== undefined) scored.push({ id, score: s, i })
	})
	scored.sort((a, b) => b.score - a.score || a.id.length - b.id.length || a.i - b.i)
	return scored.map((s) => s.id)
}

// The rows of `node`'s children that hold a `kept` id, `open` categories
// showing theirs: categories, then models, then the buckets. `open` gets
// whether the category shows by itself while searching: all do but a
// bucket whose parent has matches outside it ("gpt" keeps gpt/older
// closed, "gpt 5.5" opens it).
function rows(
	node: Node,
	kept: Set<string>,
	open: (path: string, auto: boolean) => boolean,
	current: string,
	names: Record<string, string>,
	depth = 0,
	out = { items: [] as string[], values: [] as string[], rows: [] as TreeRow[] },
) {
	let indent = '  '.repeat(depth)
	let category = (n: Node) => {
		if (!n.all.some((id) => kept.has(id))) return
		let shown = open(n.path, !modelTree.bucket(n) || !node.all.some((id) => kept.has(id) && !n.all.includes(id)))
		out.items.push(
			`${indent}${shown ? '▼' : '▶'} ${n.name}${n.default ? ` (default: ${n.default.slice(n.default.indexOf('/') + 1)})` : ''}`,
		)
		out.values.push('')
		out.rows.push({
			path: n.path,
			open: shown,
			...(node.path ? { parent: node.path } : {}),
			...(n.default ? { default: n.default } : {}),
		})
		if (shown) rows(n, kept, open, current, names, depth + 1, out)
	}
	node.nodes.filter((n) => !modelTree.bucket(n)).forEach(category)
	for (let { id, leaf, family } of node.ids) {
		if (!kept.has(id)) continue
		// ✓ marks the current model; the category header names the
		// default (task r7r). The postfix follows the hierarchy; the full
		// name and ID are details. A singleton such as Haiku needs only
		// its short name.
		let name = names[id]
		let label = id.startsWith('hal/') ? id : family ? leaf : name ? titles.shortName(id, name) : id
		out.items.push(`${indent}${id === current ? '✓ ' : '  '}${label}`)
		// Rows outside a family still need the effort cell (task r7r).
		out.values.push(family ? `\t${name ?? ''}\t${id}` : id.startsWith('hal/') ? `\t${name ?? ''}\t` : '\t\t')
		out.rows.push({ id, parent: node.path })
	}
	node.nodes.filter(modelTree.bucket).forEach(category)
	return out
}

// The list again for the search box and open categories now, selecting
// `select` (a category path or model id) if it is shown.
function refilter(st: ModalState, ids: string[], names: Record<string, string> = {}, select?: string): ModalState {
	let t = st.tree ?? { rows: [], open: [], current: '' }
	let input = (st.form?.values[0] ?? '').trim()
	let colon = ids.includes(input) ? -1 : input.lastIndexOf(':')
	let query = colon < 0 ? input : input.slice(0, colon)
	t = { ...t, searchEffort: colon < 0 || colon === input.length - 1 ? undefined : input.slice(colon + 1) }
	let ranked = query ? picker.rank(ids, query, names) : ids
	let closed = t.closed ?? []
	let opened = t.opened ?? []
	let shown = query
		? (p: string, auto: boolean) => !closed.includes(p) && (auto || opened.includes(p))
		: (p: string) => t.open.includes(p)
	let built = rows(modelTree.tree(ids, t.current), new Set(ranked), shown, t.current, names)
	built.rows = built.rows.map(
		(row) =>
			t.rows.find(
				(old) =>
					(row.id ? old.id === row.id : old.path === row.path) &&
					old.open === row.open &&
					old.default === row.default &&
					old.parent === row.parent,
			) ?? row,
	)
	let at = (want?: string) => (want === undefined ? -1 : built.rows.findIndex((r) => r.path === want || r.id === want))
	let selected = at(select)
	if (selected < 0 && query) {
		// A matching category first, else the best model; ties go to an
		// alias's model ("claude": opus 5.5), else the higher row, so the
		// most capable of equal matches.
		let q = fuzzy.words(query)
		let preferred = new Set(Object.keys(modelAliases.families).map((alias) => modelAliases.select(alias, ids)))
		let best = (text: (r: TreeRow) => string | undefined) => {
			let found = { i: -1, score: -1, preferred: false }
			built.rows.forEach((r, i) => {
				let s = text(r) === undefined ? undefined : fuzzy.score(text(r)!, q)
				let p = !!r.id && preferred.has(r.id)
				if (s !== undefined && (s > found.score || (s === found.score && p && !found.preferred)))
					found = { i, score: s, preferred: p }
			})
			return found.i
		}
		selected = best((r) => r.path)
		if (selected < 0) selected = best((r) => (r.id ? (names[r.id] ? `${r.id} ${names[r.id]}` : r.id) : undefined))
	}
	if (selected < 0) selected = Math.max(0, at(t.current))
	return picker.selection({
		...st,
		items: built.items,
		values: built.values,
		query,
		tree: { ...t, rows: built.rows },
		selected,
	})
}

// Refresh just the selected row's presentation: Up/Down must not rebuild
// and sort the catalog. `previous` is the row losing its effort marker.
function selection(st: ModalState, previous?: number): ModalState {
	let t = st.tree!
	// Model rows' values are effort, name and ID cells; only the selected
	// row fills the effort cell.
	let values = st.values ? [...st.values] : undefined
	let effortCell = (i: number, text: string) => {
		let v = values?.[i]
		if (v) values![i] = text + v.slice(v.indexOf('\t'))
	}
	if (previous !== undefined) effortCell(previous, '')
	effortCell(st.selected, '')
	let row = t.rows[st.selected]
	let shownId = row?.id ?? row?.default ?? t.current
	let effortKeys = !!t.capabilities?.[shownId]?.levels.length
	let hint = row?.id
		? `${effortKeys ? '←→: effort · ' : ''}enter: pick`
		: `←→: close/open · enter: ${row?.default ? 'pick default' : 'open'}`
	let level = picker.label(st, shownId)
	// A chevron shows only where ←/→ can still move; the level keeps its
	// column when the left one is gone.
	if (row?.id && level)
		effortCell(
			st.selected,
			`${picker.canAdjust(st, 'left') ? '‹ ' : '  '}${level}${picker.canAdjust(st, 'right') ? ' ›' : ''}`,
		)
	let chosen = picker.level(st, shownId)
	let cap = t.capabilities?.[shownId]
	let fallback = cap?.levels.length ? (cap.policy ?? cap.default) : undefined
	// The title is what Enter sends: the model, with :level only off its default.
	let title =
		row && (row.id || row.default) ? `Model: ${shownId}${chosen && chosen !== fallback ? `:${chosen}` : ''}` : 'Model'
	return { ...st, title, ...(values && { values }), hint: `${hint} · esc: close` }
}

// The picker over `ids`, on the current model, its categories open.
function open(
	current: string,
	ids: string[],
	names: Record<string, string> = {},
	capabilities?: Record<string, EffortCapability>,
	selectedEffort?: string,
): ModalState {
	let st = {
		...modals.open({
			title: 'Model',
			form: { text: 'Switch model', fields: [{ type: 'text', name: 'search', placeholder: 'opus, gpt, 5.5…' }] },
		}),
		question: 'Which model and effort?',
	}
	let open = modelTree.ancestors(modelTree.tree(ids, current), current)
	return picker.refilter(
		{ ...st, tree: { rows: [], open, current, capabilities, ...(selectedEffort && { effort: selectedEffort }) } },
		ids,
		names,
	)
}

// The open picker `st` over a newer list, keeping its search and
// selection: provider lists that arrive after opening.
function refresh(
	st: ModalState,
	ids: string[],
	names: Record<string, string> = {},
	capabilities?: Record<string, EffortCapability>,
): ModalState {
	let t = st.tree!
	let row = t.rows[st.selected]
	return picker.refilter(
		{ ...st, tree: { ...t, capabilities: capabilities ?? t.capabilities } },
		ids,
		names,
		row?.id ?? row?.path,
	)
}

// A key on the picker. Left and right are the tree's, whatever the
// search box holds (Ctrl-A/E move in it): right opens the selected
// category, left closes it or the one the selection is in. Enter on a
// category without a default toggles it. The rest is the modal's
// (typing refilters, reopening every category; Enter picks).
function step(
	st: ModalState,
	key: Key,
	ids: string[],
	names: Record<string, string> = {},
): { state: ModalState; action?: ModalAction } {
	let t = st.tree
	let row = t?.rows[st.selected]
	let plain = !key.ctrl && !key.alt && !key.cmd && !key.shift
	if (t && row?.id && plain && (key.key === 'left' || key.key === 'right')) {
		let id = row.id
		let cap = t.capabilities?.[id]
		if (!cap?.levels.length) return { state: st }
		let selected = picker.level(st, id) ?? cap.policy ?? cap.default
		let at =
			selected === undefined ? (key.key === 'right' ? -1 : cap.levels.length) : cap.levels.indexOf(selected as any)
		let level = cap.levels[Math.max(0, Math.min(cap.levels.length - 1, at + (key.key === 'right' ? 1 : -1)))]!
		let form = st.form
		if (t.searchEffort !== undefined && form) {
			let input = form.values[0]!
			form = forms.set(form, 0, `${input.slice(0, input.lastIndexOf(':'))}:${level}`)
		}
		return { state: picker.refilter({ ...st, form, tree: { ...t, effort: level } }, ids, names, id) }
	}
	if (
		t &&
		row &&
		plain &&
		(key.key === 'left' || key.key === 'right' || (key.key === 'enter' && row.path && !row.default))
	) {
		let searching = !!(st.form?.values[0] ?? '').trim()
		let isOpen = (p: string) => !!t.rows.find((r) => r.path === p)?.open
		let set = (path: string, open: boolean) => {
			let others = (list: string[]) => list.filter((p) => p !== path)
			let tree = searching
				? {
						...t,
						closed: open ? others(t.closed ?? []) : [...others(t.closed ?? []), path],
						opened: open ? [...others(t.opened ?? []), path] : others(t.opened ?? []),
					}
				: { ...t, open: open ? [...t.open, path] : t.open.filter((p) => p !== path) }
			return { state: picker.refilter({ ...st, tree }, ids, names, path) }
		}
		let toggle = key.key === 'enter'
		if (row.path && (key.key === 'right' || toggle) && !isOpen(row.path)) return set(row.path, true)
		if (row.path && (key.key === 'left' || toggle) && isOpen(row.path)) return set(row.path, false)
		if (key.key === 'left' && row.parent) return set(row.parent, false)
		return { state: st }
	}
	let r = modals.step(st, key)
	if (r.action) return r
	let edited = r.state.form?.values[0] !== st.form?.values[0]
	if (!edited) return t && r.state.selected !== st.selected ? { state: picker.selection(r.state, st.selected) } : r
	return {
		state: picker.refilter({ ...r.state, ...(t ? { tree: { ...t, closed: [], opened: [] } } : {}) }, ids, names),
	}
}

// The command Enter sends: switch the session to the selected model, or
// to the selected category's default. A draft at the model's default
// sends :default, so the session pins no level.
function command(
	sessionId: string,
	st: ModalState,
	action: Extract<ModalAction, { type: 'submit' }>,
): { type: 'submit'; sessionId: string; text: string } | undefined {
	let row = action.item === undefined ? undefined : st.tree?.rows[action.item]
	let id = row?.id ?? row?.default
	if (id === undefined) return undefined
	let cap = st.tree?.capabilities?.[id]
	let selected = st.tree?.searchEffort ?? picker.level(st, id)
	if (st.tree?.searchEffort === undefined && selected !== undefined && selected === (cap?.policy ?? cap?.default))
		selected = 'default'
	return { type: 'submit', sessionId, text: `/model ${id}${selected === undefined ? '' : `:${selected}`}` }
}
// The level the picker's effort draft gives `id`: its nearest one.
function level(st: ModalState, id: string): string | undefined {
	let cap = st.tree?.capabilities?.[id]
	let asked = st.tree?.searchEffort ?? st.tree?.effort
	let draft = (asked === 'ultra' ? 'max' : asked) as EffortLevel | undefined
	return draft && effortLevels.levels.includes(draft) && cap?.levels.length
		? effortLevels.closest(cap.levels, draft)
		: undefined
}
// The effort choice of `id`'s row; '' without effort control.
function label(st: ModalState, id: string): string {
	let cap = st.tree?.capabilities?.[id]
	return cap?.levels.length ? effortLevels.label(cap, picker.level(st, id)) : ''
}
// The effort column's width: the widest choice of any model row, with
// both chevrons, so moving and ←/→ never shift the columns.
function effortWidth(st: ModalState): number {
	let widest = 0
	for (let r of st.tree?.rows ?? []) {
		let cap = r.id ? st.tree?.capabilities?.[r.id] : undefined
		if (!cap?.levels.length) continue
		for (let l of [undefined, ...cap.levels]) widest = Math.max(widest, effortLevels.label(cap, l).length + 4)
	}
	return widest
}
function canAdjust(st: ModalState, direction: 'left' | 'right'): boolean {
	let id = st.tree?.rows[st.selected]?.id
	let cap = id ? st.tree?.capabilities?.[id] : undefined
	if (!id || !cap?.levels.length) return false
	let selected = picker.level(st, id) ?? cap.policy ?? cap.default
	return selected === undefined || selected !== cap.levels[direction === 'left' ? 0 : cap.levels.length - 1]
}
export const picker = { rank, refilter, selection, refresh, open, step, command, level, label, canAdjust, effortWidth }
