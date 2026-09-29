// Transient find protocol and ranking, shared by host and clients.
export type FindKind = 'metadata' | 'user' | 'assistant' | 'thinking' | 'tool-call' | 'tool-output' | 'other'
export type FindFilter = 'text' | 'thinking' | 'tools' | 'other'
export type FindResult = { sessionId: string; name: string; blockId: string; kind: FindKind; age: number; snippet: string; score: number; href: string }
export type FindBatch = { type: 'find-results'; request: string; tier: FindKind; results: FindResult[]; done: boolean; scanning?: number; error?: string }
export type FindQuery = { words: string[]; kinds: FindKind[]; model?: string; cwd?: string; since?: number }
const tiers: FindKind[] = ['metadata', 'user', 'assistant', 'thinking', 'tool-call', 'tool-output', 'other']
const groups: Record<string, FindKind[]> = { text: ['user', 'assistant'], thinking: ['thinking'], tools: ['tool-call', 'tool-output'], other: ['other'], user: ['user'], assistant: ['assistant'], 'tool-call': ['tool-call'], 'tool-output': ['tool-output'], metadata: ['metadata'] }

function parse(text: string, filters?: FindFilter[]): FindQuery {
	let q: FindQuery = { words: [], kinds: [...tiers] }
	if (filters) q.kinds = ['metadata', ...tiers.filter((k) => filters.some((f) => groups[f]!.includes(k)))]
	for (let word of text.trim().split(/\s+/).filter(Boolean)) {
		let m = /^(in|model|cwd|since):(.+)$/i.exec(word)
		if (!m) { q.words.push(word.toLocaleLowerCase()); continue }
		let value = m[2]!
		switch (m[1]!.toLowerCase()) {
			case 'in': {
				let kinds = value.split(',').flatMap((k) => {
					let group = groups[k.toLowerCase()]
					if (!group) throw new Error(`unknown find kind: ${k}`)
					return group
				})
				q.kinds = q.kinds.filter((k) => kinds.includes(k))
				break
			}
			case 'model': q.model = value.toLocaleLowerCase(); break
			case 'cwd': q.cwd = value.toLocaleLowerCase(); break
			case 'since': {
				let age = /^(\d+(?:\.\d+)?)(m|h|d|w)$/i.exec(value)
				if (!age) throw new Error('since: use an age such as 30m, 12h, 3d or 2w')
				q.since = Number(age[1]) * ({ m: 60000, h: 3600000, d: 86400000, w: 604800000 }[age[2]!.toLowerCase()]!)
				break
			}
		}
	}
	return q
}

function match(text: string, words: string[], age: number): { score: number; snippet: string } | undefined {
	let lower = text.toLocaleLowerCase(), quality = words.length ? 0 : 1, at = 0
	for (let word of words) {
		let best = 0, pos = lower.indexOf(word)
		while (pos >= 0) {
			let start = !/[\p{L}\p{N}_]/u.test(lower[pos - 1] ?? ''), end = !/[\p{L}\p{N}_]/u.test(lower[pos + word.length] ?? '')
			let score = start ? (end ? 3 : 2) : 1
			if (score > best) { best = score; at = pos }
			if (best === 3) break
			pos = lower.indexOf(word, pos + 1)
		}
		if (!best) return undefined
		quality += best
	}
	let from = Math.max(0, at - 45), to = Math.min(text.length, from + 180)
	return { score: quality * Math.pow(0.5, age / 259200000), snippet: (from ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : '') }
}

export const findQuery = { tiers, groups, parse, match }
