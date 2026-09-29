// The model picker (tasks/w4/forms.md, Model picker): a modal with a
// search box over a tree of the host's model ids, like the old Hal's:
// provider, then family or vendor, then models. ▶ and ▼ mark closed and
// open categories; right and left open and close them. A category Enter
// picks its default model. Typing filters and ranks the models, opens
// the categories that hold them and selects the best match, a matching
// category first (typing "gp" selects openai/gpt). Enter ends in an
// ordinary command, `/model <id>`. Shared by terminal and web; the list
// itself comes from the host (the `models` event).

import type { Key } from './forms.ts'
import type { ModalAction, ModalState, TreeRow } from './modals.ts'
import { modals } from './modals.ts'

// Lowercase words, split at anything not a letter or digit and between
// letters and digits: "Opus-5.5" and "opus5 5" are both opus, 5, 5.
function words(s: string): string[] {
	return s.toLowerCase().match(/[a-z]+|[0-9]+/g) ?? []
}

// How well `id` matches the query words, or undefined if it does not:
// each word must appear, in order, preferably where a word of the id
// starts. Whole words and words right after the previous match score
// higher, so "opus-5.5" prefers claude-opus-5-5 to claude-opus-5-15.
function score(id: string, query: string[]): number | undefined {
	let parts = words(id)
	let text = parts.join(' ')
	let starts = new Set<number>()
	let at = 0
	for (let p of parts) {
		starts.add(at)
		at += p.length + 1
	}
	let total = 0
	let pos = 0
	let lastEnd = -1
	for (let q of query) {
		let found = -1
		for (let i = text.indexOf(q, pos); i >= 0; i = text.indexOf(q, i + 1)) {
			if (found < 0) found = i
			if (starts.has(i)) {
				found = i
				break
			}
		}
		if (found < 0) return undefined
		let end = found + q.length
		if (starts.has(found)) total += 2
		if (starts.has(found) && (end === text.length || text[end] === ' ')) total += 1
		if (lastEnd >= 0 && found === lastEnd + 1) total += 3
		lastEnd = end
		pos = end
	}
	return total
}

// The ids matching `query`, best first; ties keep the given order,
// shorter ids first. An empty query keeps every id in order. An id's
// display name in `names` matches too, after the id itself.
function rank(ids: string[], query: string, names: Record<string, string> = {}): string[] {
	let q = words(query)
	if (!q.length) return ids
	let scored: { id: string; score: number; i: number }[] = []
	ids.forEach((id, i) => {
		let s = score(names[id] ? `${id} ${names[id]}` : id, q)
		if (s !== undefined) scored.push({ id, score: s, i })
	})
	scored.sort((a, b) => b.score - a.score || a.id.length - b.id.length || a.i - b.i)
	return scored.map((s) => s.id)
}

// What the family aliases pick now (/model gpt, /model opus), and so the
// default of their categories. Other categories default to their newest.
const defaults: Record<string, string> = { gpt: 'openai/gpt-6-sol', opus: 'anthropic/claude-opus-5-5' }
// Providers in the old Hal's order; others follow in the host's order.
const providers = ['hal', 'openai', 'anthropic', 'google', 'opencode-go', 'openrouter']
const FAMILY = /(?:^|[-_])(fable|opus|sonnet|haiku|gpt|gemini|grok|kimi|qwen|deepseek|glm|minimax)(?=[-_.\d]|$)/i
// Not chat models: a direct provider lists them under its `other`.
const SPECIAL = /(?:^|[-_.])(?:image|realtime|audio|tts|transcribe|embedding|moderation|search|whisper|dall-e|sora|computer-use)(?=[-_.\d]|$)/i
const newest = new Intl.Collator('en', { numeric: true })
// Families of a provider, most capable first; others follow by name.
const families = ['fable', 'opus', 'sonnet', 'haiku', 'gpt']
// Flagship variants of a version: the plain model, then these tiers.
// Other variants (mini, pro, codex, daybreak...) go under `older`.
const tiers = ['sol', 'terra', 'luna', 'astra']
// The closed-by-default buckets: a family's older versions and variants,
// a provider's non-chat and family-less models. Listed last, no default.
const OLDER = 'older'
const OTHER = 'other'
const bucket = (n: Node) => n.path.includes('/') && (n.name === OLDER || n.name === OTHER)
const DATED = /[-_](?:\d{8}|\d{4}-\d{2}-\d{2})$/
const version = (leaf: string) => Number(/^\d+(?:\.\d+)?/.exec(leaf)?.[0] ?? NaN)
const tier = (leaf: string) => {
	let rest = leaf.replace(/^[\d.]+[-_]?/, '')
	return rest ? (tiers.includes(rest) ? tiers.indexOf(rest) + 1 : tiers.length + 1) : 0
}

type Node = { name: string; path: string; nodes: Node[]; ids: { id: string; leaf: string; family: boolean }[]; all: string[]; default?: string }

// Where `id` goes: its category path and its label there. A direct
// provider's models group by family when two or more share one; a
// reseller's (openrouter/vendor/model) by vendor. A family lists its two
// newest versions' flagship variants (gpt: 6 and 5.6; sol, terra, luna,
// astra), the rest under family/older. A provider with families lists
// non-chat and family-less models (image, realtime, o3) under
// provider/other. A dated snapshot hides behind its undated alias unless
// it is `keep`, the session's model.
function tree(ids: string[], keep = ''): Node {
	let all = new Set(ids)
	let placed = ids.flatMap((id) => {
		let parts = id.split('/')
		if (parts.length < 2 || (id !== keep && DATED.test(id) && all.has(id.replace(DATED, '')))) return []
		let model = parts.pop()!
		let special = parts.length === 1 && SPECIAL.test(model)
		let family = parts.length === 1 && !special ? FAMILY.exec(model)?.[1]?.toLowerCase() : undefined
		return [{ id, path: parts, model, family, special }]
	})
	let count = new Map<string, number>()
	for (let p of placed) if (p.family) count.set(`${p.path[0]}/${p.family}`, (count.get(`${p.path[0]}/${p.family}`) ?? 0) + 1)
	let withFamilies = new Set(placed.filter((p) => p.family).map((p) => p.path[0]))
	let root: Node = { name: '', path: '', nodes: [], ids: [], all: [] }
	let node = (path: string[]) => {
		let at = root
		for (let name of path) {
			let full = at.path ? `${at.path}/${name}` : name
			let next = at.nodes.find((n) => n.path === full)
			if (!next) at.nodes.push((next = { name, path: full, nodes: [], ids: [], all: [] }))
			at = next
		}
		return at
	}
	for (let p of placed) {
		let leaf = p.model
		let path = p.path
		let grouped = !!p.family && count.get(`${path[0]}/${p.family}`)! > 1
		if (grouped) {
			let at = p.model.toLowerCase().indexOf(p.family!) + p.family!.length
			leaf = (p.model.slice(at).replace(/^[-_.]/, '') || p.model).replace(/(\d)-(?=\d)/g, '$1.')
			path = [...path, p.family!]
		} else if (p.special || (!p.family && path.length === 1 && withFamilies.has(path[0]!))) path = [...path, OTHER]
		node(path).ids.push({ id: p.id, leaf, family: grouped })
	}
	let order = (list: string[], n: Node) => (bucket(n) ? Infinity : list.includes(n.name) ? list.indexOf(n.name) : list.length)
	root.nodes.sort((a, b) => order(providers, a) - order(providers, b))
	let finish = (n: Node): string[] => {
		if (n.ids.some((i) => i.family) && n.name !== OLDER) {
			let top = [...new Set(n.ids.map((i) => version(i.leaf)).filter((v) => !isNaN(v)))].sort((a, b) => b - a).slice(0, 2)
			let flagship = (i: Node['ids'][number]) => top.includes(version(i.leaf)) && tier(i.leaf) <= tiers.length
			let rest = n.ids.filter((i) => !flagship(i))
			n.ids = n.ids.filter(flagship)
			if (rest.length) n.nodes.push({ name: OLDER, path: `${n.path}/${OLDER}`, nodes: [], ids: rest, all: [] })
		}
		n.nodes.sort((a, b) => order(families, a) - order(families, b) || a.name.localeCompare(b.name))
		n.ids.sort((a, b) =>
			a.family && b.family ? version(b.leaf) - version(a.leaf) || tier(a.leaf) - tier(b.leaf) || a.leaf.localeCompare(b.leaf) : newest.compare(b.id, a.id))
		let inner = n.nodes.filter((c) => !bucket(c)).flatMap(finish)
		let later = n.nodes.filter(bucket).flatMap(finish)
		n.all = [...inner, ...n.ids.map((i) => i.id), ...later]
		let preferred = Object.values(defaults).find((id) => n.all.includes(id))
		// A provider has a default only through an alias (anthropic: opus);
		// a bucket has none, so Enter opens it.
		n.default = bucket(n) ? undefined : preferred ?? (n.path.includes('/') ? n.all[0] : undefined)
		n.ids.sort((a, b) => Number(b.id === n.default) - Number(a.id === n.default))
		return n.all
	}
	root.nodes.forEach(finish)
	return root
}

// The rows of `node`'s children that hold a `kept` id, `open` categories
// showing theirs: categories, then models, then the buckets.
function rows(node: Node, kept: Set<string>, open: (path: string) => boolean, current: string, names: Record<string, string>, depth = 0, out = { items: [] as string[], rows: [] as TreeRow[] }) {
	let indent = '  '.repeat(depth)
	let category = (n: Node) => {
		if (!n.all.some((id) => kept.has(id))) return
		let shown = open(n.path)
		let base = n.default?.slice(n.default.indexOf('/') + 1)
		out.items.push(`${indent}${shown ? '▼' : '▶'} ${n.name}${base ? `  (default: ${base})` : ''}`)
		out.rows.push({ path: n.path, ...(node.path ? { parent: node.path } : {}), ...(n.default ? { default: n.default } : {}) })
		if (shown) rows(n, kept, open, current, names, depth + 1, out)
	}
	node.nodes.filter((n) => !bucket(n)).forEach(category)
	for (let { id, leaf } of node.ids) {
		if (!kept.has(id)) continue
		out.items.push(`${indent}${id === current ? '* ' : '  '}${leaf.padEnd(12)} ${names[id] ? `${names[id]} · ` : ''}${id}`)
		out.rows.push({ id, parent: node.path })
	}
	node.nodes.filter(bucket).forEach(category)
	return out
}

// The categories that hold `id`, outermost first.
function ancestors(root: Node, id: string): string[] {
	for (let n of root.nodes) {
		if (n.ids.some((i) => i.id === id)) return [n.path]
		let inner = ancestors(n, id)
		if (inner.length) return [n.path, ...inner]
	}
	return []
}

// The list again for the search box and open categories now, selecting
// `select` (a category path or model id) if it is shown.
function refilter(st: ModalState, ids: string[], names: Record<string, string> = {}, select?: string): ModalState {
	let t = st.tree ?? { rows: [], open: [], current: '' }
	let query = (st.form?.values[0] ?? '').trim()
	let ranked = query ? picker.rank(ids, query, names) : ids
	let closed = t.closed ?? []
	let built = rows(tree(ids, t.current), new Set(ranked), query ? (p) => !closed.includes(p) : (p) => t.open.includes(p), t.current, names)
	let at = (want?: string) => (want === undefined ? -1 : built.rows.findIndex((r) => r.path === want || r.id === want))
	let selected = at(select)
	if (selected < 0 && query) {
		// A matching category first, else the best model; ties go to an
		// alias's model ("claude": opus 5.5), else the higher row, so the
		// most capable of equal matches.
		let q = words(query)
		let preferred = new Set(Object.values(defaults))
		let best = (text: (r: TreeRow) => string | undefined) => {
			let found = { i: -1, score: -1, preferred: false }
			built.rows.forEach((r, i) => {
				let s = text(r) === undefined ? undefined : score(text(r)!, q)
				let p = !!r.id && preferred.has(r.id)
				if (s !== undefined && (s > found.score || (s === found.score && p && !found.preferred))) found = { i, score: s, preferred: p }
			})
			return found.i
		}
		selected = best((r) => r.path)
		if (selected < 0) selected = best((r) => (r.id ? (names[r.id] ? `${r.id} ${names[r.id]}` : r.id) : undefined))
	}
	if (selected < 0) selected = Math.max(0, at(t.current))
	let row = built.rows[selected]
	let hint = row?.id ? 'enter: pick' : row?.default ? 'enter: pick default' : 'enter: open'
	return { ...st, items: built.items, tree: { ...t, rows: built.rows }, selected, hint: `←/→: close/open, ${hint}, esc: cancel` }
}

// The picker over `ids`, on the current model, its categories open.
function open(current: string, ids: string[], names: Record<string, string> = {}): ModalState {
	let st = modals.open({ title: `Model: ${current}`, form: { text: 'Switch model', fields: [{ type: 'text', name: 'search', label: 'Search' }] } })
	let open = ancestors(tree(ids, current), current)
	return picker.refilter({ ...st, tree: { rows: [], open, current } }, ids, names)
}

// A key on the picker. Left and right are the tree's, whatever the
// search box holds (Ctrl-A/E move in it): right opens the selected
// category, left closes it or the one the selection is in. Enter on a
// category without a default toggles it. The rest is the modal's
// (typing refilters, reopening every category; Enter picks).
function step(st: ModalState, key: Key, ids: string[], names: Record<string, string> = {}): { state: ModalState; action?: ModalAction } {
	let t = st.tree
	let row = t?.rows[st.selected]
	let plain = !key.ctrl && !key.alt && !key.cmd && !key.shift
	if (t && row && plain && (key.key === 'left' || key.key === 'right' || (key.key === 'enter' && row.path && !row.default))) {
		let searching = !!(st.form?.values[0] ?? '').trim()
		let closed = t.closed ?? []
		let isOpen = (p: string) => (searching ? !closed.includes(p) : t.open.includes(p))
		let set = (path: string, open: boolean) => {
			let tree = searching
				? { ...t, closed: open ? closed.filter((p) => p !== path) : [...closed, path] }
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
	if (r.action || r.state.form?.values[0] === st.form?.values[0]) return r
	return { state: picker.refilter({ ...r.state, ...(t ? { tree: { ...t, closed: [] } } : {}) }, ids, names) }
}

// The command Enter sends: switch the session to the selected model, or
// to the selected category's default.
function command(sessionId: string, st: ModalState, action: Extract<ModalAction, { type: 'submit' }>): { type: 'submit'; sessionId: string; text: string } | undefined {
	let row = action.item === undefined ? undefined : st.tree?.rows[action.item]
	let id = row?.id ?? row?.default
	return id === undefined ? undefined : { type: 'submit', sessionId, text: `/model ${id}` }
}

export const picker = { defaults, rank, refilter, open, step, command }
