// Groups a host's model ids into the picker's tree (tasks/w4/forms.md,
// Model picker): provider, family or vendor, models, with closed
// `older` and `other` buckets and each category's default.

import { modelAliases } from './model-aliases.ts'

// Providers in the old Hal's order; others follow in the host's order.
const providers = ['hal', 'openai', 'anthropic', 'google', 'opencode-go', 'openrouter']
const FAMILY = /(?:^|[-_])(fable|opus|sonnet|haiku|gpt|gemini|grok|kimi|qwen|deepseek|glm|minimax)(?=[-_.\d]|$)/i
// Not chat models: a direct provider lists them under its `other`.
const SPECIAL =
	/(?:^|[-_.])(?:image|realtime|audio|tts|transcribe|embedding|moderation|search|whisper|dall-e|sora|computer-use)(?=[-_.\d]|$)/i
const newest = new Intl.Collator('en', { numeric: true })
// Families of a provider, most capable first; others follow by name.
const families = ['fable', 'opus', 'sonnet', 'haiku', 'gpt']
// Flagship variants of a version: the plain model, then these tiers,
// then any other name (gemini argon, neon, flash) unless it is minor.
// Minor variants and older versions go under `older`.
const tiers = ['sol', 'terra', 'luna', 'astra']
// GPT pro is a costly side variant; Gemini pro is the flagship.
const minor = (family: string, leaf: string) =>
	leaf
		.replace(/^[\d.]+/, '')
		.split(/[-_]/)
		.some((word) => ['mini', 'nano', 'lite', 'codex'].includes(word) || (family === 'gpt' && word === 'pro'))
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

export type Node = {
	name: string
	path: string
	nodes: Node[]
	ids: { id: string; leaf: string; family: boolean }[]
	all: string[]
	default?: string
}

// Where `id` goes: its category path and its label there. A direct
// provider's models group by family when two or more share one; a
// reseller's (openrouter/vendor/model) by vendor. A family lists its two
// newest versions' flagship variants (gpt 6 and 5.6; gemini 4 and 3.8),
// the rest under family/older. A provider with families lists
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
	for (let p of placed)
		if (p.family) count.set(`${p.path[0]}/${p.family}`, (count.get(`${p.path[0]}/${p.family}`) ?? 0) + 1)
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
	let order = (list: string[], n: Node) =>
		bucket(n) ? Infinity : list.includes(n.name) ? list.indexOf(n.name) : list.length
	root.nodes.sort((a, b) => order(providers, a) - order(providers, b))
	let finish = (n: Node): string[] => {
		if (n.ids.some((i) => i.family) && n.name !== OLDER) {
			let top = [...new Set(n.ids.map((i) => version(i.leaf)).filter((v) => !isNaN(v)))]
				.sort((a, b) => b - a)
				.slice(0, 2)
			let flagship = (i: Node['ids'][number]) => top.includes(version(i.leaf)) && !minor(n.name, i.leaf)
			let rest = n.ids.filter((i) => !flagship(i))
			n.ids = n.ids.filter(flagship)
			if (rest.length) n.nodes.push({ name: OLDER, path: `${n.path}/${OLDER}`, nodes: [], ids: rest, all: [] })
		}
		n.nodes.sort((a, b) => order(families, a) - order(families, b) || a.name.localeCompare(b.name))
		n.ids.sort((a, b) =>
			a.family && b.family
				? version(b.leaf) - version(a.leaf) || tier(a.leaf) - tier(b.leaf) || a.leaf.localeCompare(b.leaf)
				: newest.compare(b.id, a.id),
		)
		let inner = n.nodes.filter((c) => !bucket(c)).flatMap(finish)
		let later = n.nodes.filter(bucket).flatMap(finish)
		n.all = [...inner, ...n.ids.map((i) => i.id), ...later]
		let preferred = modelAliases.select(
			({ 'z-ai': 'glm', moonshotai: 'kimi' } as Record<string, string>)[n.name] ?? n.name,
			n.all,
		)
		// A provider has a default only through an alias (anthropic: opus);
		// a bucket has none, so Enter opens it.
		n.default = bucket(n)
			? undefined
			: (preferred ?? (!modelAliases.families[n.name] && n.path.includes('/') ? n.all[0] : undefined))
		n.ids.sort((a, b) => Number(b.id === n.default) - Number(a.id === n.default))
		return n.all
	}
	root.nodes.forEach(finish)
	return root
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

export const modelTree = { tree, bucket, ancestors }
