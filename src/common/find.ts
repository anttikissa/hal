// Find messages and ranking, shared so host and clients agree on what
// matches. Find results are transient: never stored.
export type FindKind = 'metadata' | 'user' | 'assistant' | 'thinking' | 'tool-call' | 'tool-output' | 'commit' | 'other'
export type FindFilter = 'user' | 'hal' | 'reasoning' | 'tools' | 'commits' | 'other'
export type FindResult = {
	sessionId: string
	name: string
	blockId: string
	// Card id as the transcript shows it, e.g. a1313; empty for session matches.
	card: string
	kind: FindKind
	// The evidence: title, former title, commit, request, files, reply...
	why: string
	// Tab rows: how many cards of the tab matched. Card rows: 0.
	count: number
	age: number
	snippet: string
	score: number
	href: string
}
export type FindBatch = {
	type: 'find-results'
	request: string
	tier: FindKind
	results: FindResult[]
	done: boolean
	scanning?: number
	error?: string
}
export type FindQuery = {
	words: string[]
	// "Quoted words": whole-word phrases.
	phrases: string[]
	exclude: string[]
	kinds: FindKind[]
	// in: values other than kind names: here, ., ids, tab numbers, paths.
	scope: string[]
	since?: number
}
// Strong evidence streams first, so the first batches already rank well.
const tiers: FindKind[] = ['metadata', 'commit', 'user', 'assistant', 'thinking', 'tool-call', 'tool-output', 'other']
const filters: FindFilter[] = ['user', 'hal', 'reasoning', 'tools', 'commits', 'other']
const groups: Record<FindFilter, FindKind[]> = {
	user: ['user'],
	hal: ['assistant'],
	reasoning: ['thinking'],
	tools: ['tool-call', 'tool-output'],
	commits: ['commit'],
	other: ['other'],
}
// Evidence weights, strongest first (task yhm).
const weights: Record<string, number> = {
	title: 100,
	'former title': 80,
	commit: 60,
	request: 40,
	files: 15,
	reply: 12,
	pasted: 8,
	reasoning: 4,
	tool: 3,
	other: 2,
}
const strong = ['title', 'former title', 'commit', 'request']
const scopeHelp =
	'in: takes here, a tab id (181-ibm), tab numbers (10-19), . (this directory), a path (~/x) or user, hal, reasoning, tools, commits, other'

function scopeValue(v: string): boolean {
	return /^(here|\.|\d+-[a-z]{3}|\d+(-\d+)?|[~/].*)$/i.test(v)
}
function parse(text: string, enabled?: FindFilter[]): FindQuery {
	let q: FindQuery = { words: [], phrases: [], exclude: [], kinds: [...tiers], scope: [] }
	if (enabled) {
		let all = filters.every((f) => enabled.includes(f))
		q.kinds = [
			...(all ? ['metadata' as const] : []),
			...tiers.filter((k) => enabled.some((f) => groups[f].includes(k))),
		]
	}
	let kinds: FindKind[] = []
	for (let [, quoted, word] of text.matchAll(/"([^"]*)"?|(\S+)/g)) {
		if (quoted !== undefined) {
			if (quoted.trim()) q.phrases.push(quoted.trim().replace(/\s+/g, ' ').toLocaleLowerCase())
			continue
		}
		let m = /^(in|since):(.+)$/i.exec(word!)
		if (!m) {
			if (/^-./.test(word!)) q.exclude.push(word!.slice(1).toLocaleLowerCase())
			else q.words.push(word!.toLocaleLowerCase())
			continue
		}
		let value = m[2]!
		if (m[1]!.toLowerCase() === 'in') {
			for (let v of value.split(',').filter(Boolean)) {
				let group = groups[v.toLowerCase() as FindFilter]
				if (group) kinds.push(...group)
				else if (scopeValue(v)) q.scope.push(v)
				else throw new Error(`unknown in: value ${v}. ${scopeHelp}`)
			}
		} else {
			let age = /^(\d+(?:\.\d+)?)(m|h|d|w)$/i.exec(value)
			if (!age) throw new Error('since: use an age such as 30m, 12h, 3d or 2w')
			q.since = Number(age[1]) * { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[age[2]!.toLowerCase()]!
		}
	}
	if (kinds.length) q.kinds = q.kinds.filter((k) => kinds.includes(k))
	return q
}

function bounded(lower: string, pos: number, length: number): number {
	let start = !/[\p{L}\p{N}_]/u.test(lower[pos - 1] ?? ''),
		end = !/[\p{L}\p{N}_]/u.test(lower[pos + length] ?? '')
	return start ? (end ? 3 : 2) : 1
}
// Match quality (word boundaries, phrase) and a snippet. Recency is not
// part of it: callers use it only to break ties (task yhm).
function match(
	text: string,
	words: string[],
	phrases: string[] = [],
): { quality: number; snippet: string } | undefined {
	let lower = text.toLocaleLowerCase(),
		flatLower = lower.replace(/\s+/g, ' '),
		quality = 0,
		at = -1
	for (let phrase of phrases) {
		let re = new RegExp(phrase.split(' ').map(RegExp.escape).join('\\s+'), 'g'),
			pos = -1
		for (let m of lower.matchAll(re))
			if (findQuery.bounded(lower, m.index, m[0].length) === 3) {
				pos = m.index
				break
			}
		if (pos < 0) return undefined
		quality += 4
		if (at < 0) at = pos
	}
	for (let word of words) {
		let best = 0,
			pos = lower.indexOf(word),
			first = -1
		while (pos >= 0) {
			let score = findQuery.bounded(lower, pos, word.length)
			if (score > best) {
				best = score
				first = pos
			}
			if (best === 3) break
			pos = lower.indexOf(word, pos + 1)
		}
		if (!best) return undefined
		quality += best
		if (at < 0) at = first
	}
	let terms = words.length + phrases.length
	if (!terms) return { quality: 1, snippet: text.slice(0, 160).replace(/\s+/g, ' ') }
	quality /= terms
	let phrase = words.join(' ')
	if (words.length && flatLower.includes(phrase)) quality++
	if (!phrases.length && flatLower.trim().replace(/^\//, '') === phrase) quality++
	at = Math.max(0, at)
	// A short lead, from a word start, padded so every match starts at the
	// same column: the highlights line up and clipped rows still show them.
	let flat = (s: string) => s.replace(/\s+/g, ' ')
	let lead = flat(text.slice(Math.max(0, at - 20), at)).trimStart()
	if (at > 20) lead = '…' + lead.slice(lead.indexOf(' ') + 1)
	let to = Math.min(text.length, at + 160)
	return { quality, snippet: lead.padStart(21) + flat(text.slice(at, to)) + (to < text.length ? '…' : '') }
}

export const findQuery = { tiers, filters, groups, weights, strong, scopeHelp, parse, bounded, match }
