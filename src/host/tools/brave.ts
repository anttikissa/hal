// brave: web search through the Brave Search API (task g6). The key is
// the credentials file's brave.apiKey.

import { apiKeys } from '../api-keys.ts'
import type { Tool } from '../tools.ts'

type Hit = { title?: string; url?: string; description?: string }
type Answer = { web?: { results?: Hit[] } }

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

// Brave marks matches with <strong> and escapes text as HTML.
function plain(html = ''): string {
	return html
		.replace(/<[^>]*>/g, '')
		.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) =>
			e[0] !== '#'
				? (entities[e.toLowerCase()] ?? m)
				: String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
		)
}

// Brave's hits as plain text: title, URL and snippet per hit.
function format(data: Answer): string {
	let hits = data.web?.results ?? []
	if (!hits.length) return 'No results found.'
	return hits.map((hit) => `${plain(hit.title)}\n${hit.url ?? ''}\n${plain(hit.description)}`).join('\n\n')
}

const defaultNum = 5

export const tool: Tool & { url: string; format: typeof format } = {
	name: 'brave',
	syntax: { usage: [`BRAVE "search terms" [ { num: ${defaultNum} } ]`] },
	description: 'Search the web with Brave Search. Returns titles, URLs and snippets.',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Search query' },
			num: {
				type: 'integer',
				minimum: 1,
				maximum: 10,
				default: defaultNum,
				description: 'Number of results, at most 10',
			},
		},
		required: ['query'],
	},
	url: 'https://api.search.brave.com/res/v1/web/search',
	format,
	async run(input, ctx) {
		let query = typeof input.query === 'string' ? input.query.trim() : ''
		if (!query) throw new Error('query must be a non-empty string')
		let num = Math.min(10, Math.max(1, Number.isInteger(input.num) ? (input.num as number) : defaultNum))
		let key = apiKeys.get('brave')
		if (!key) throw new Error('no Brave Search API key: set brave: { apiKey } in the credentials file, or run /intro')
		let res = await fetch(`${tool.url}?${new URLSearchParams({ q: query, count: String(num) })}`, {
			headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
			// A hung Brave must not hold the turn until Escape.
			signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
		})
		if (!res.ok) throw new Error(`Brave answered ${res.status}: ${(await res.text()).slice(0, 500)}`)
		return tool.format((await res.json()) as Answer)
	},
}
