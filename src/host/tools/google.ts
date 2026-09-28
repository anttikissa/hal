// google: web search through Serper (task g6). The key is the
// credentials file's serper.apiKey or SERPER_API_KEY (auth.serperKey).

import { auth } from '../auth.ts'
import type { Tool } from '../tools.ts'

type Hit = { title?: string; link?: string; snippet?: string }
type Answer = { organic?: Hit[]; answerBox?: { answer?: string; snippet?: string }; knowledgeGraph?: { title?: string; description?: string } }

// Serper's answer as plain text: answer box, knowledge graph, then hits.
function format(data: Answer): string {
	let parts: string[] = []
	let box = data.answerBox?.answer || data.answerBox?.snippet
	if (box) parts.push(`Answer: ${box}`)
	let kg = data.knowledgeGraph
	if (kg?.description) parts.push(`${kg.title ?? ''}: ${kg.description}`)
	for (let hit of data.organic ?? []) parts.push(`${hit.title ?? ''}\n${hit.link ?? ''}\n${hit.snippet ?? ''}`)
	return parts.length ? parts.join('\n\n') : 'No results found.'
}

export const tool: Tool & { url: () => string; format: typeof format } = {
	name: 'google',
	description: 'Search the web with Google (through Serper). Returns titles, URLs and snippets.',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Search query' },
			num: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of results (default 5, at most 10)' },
		},
		required: ['query'],
	},
	readOnly: true,
	url: () => 'https://google.serper.dev/search',
	format,
	async run(input, ctx) {
		let query = typeof input.query === 'string' ? input.query.trim() : ''
		if (!query) throw new Error('query must be a non-empty string')
		let num = Math.min(10, Math.max(1, Number.isInteger(input.num) ? (input.num as number) : 5))
		let key = auth.serperKey()
		if (!key) throw new Error('no Serper API key: set serper: { apiKey } in the credentials file or SERPER_API_KEY')
		let res = await fetch(tool.url(), {
			method: 'POST',
			headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
			body: JSON.stringify({ q: query, num }),
			// A hung Serper must not hold the turn until Escape.
			signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
		})
		if (!res.ok) throw new Error(`Serper answered ${res.status}: ${(await res.text()).slice(0, 500)}`)
		return tool.format((await res.json()) as Answer)
	},
}
