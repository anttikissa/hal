// Serper: Google search results for every model, through Serper
// (task g6). Hal's built-in web search is Brave; this extra adds the
// GOOGLE tool for those who prefer Google's results. The key is the
// credentials file's serper.apiKey. Also a small example of a plugin
// tool.
// Enable with plugins/serper.ts, as extras/README.md shows.
//
// Tested once, then the tests were deleted. If you change this code,
// first write tests for: answer box, knowledge graph and hits format;
// num capped at 10; a missing key errors and sends nothing; a non-2xx
// answer errors with its status and at most 500 chars of the body.
import type { Plugin } from '../src/host/plugins.ts'
import { apiKeys } from '../src/host/api-keys.ts'
import { tools, type Tool } from '../src/host/tools.ts'

type Hit = { title?: string; link?: string; snippet?: string }
type Answer = {
	organic?: Hit[]
	answerBox?: { answer?: string; snippet?: string }
	knowledgeGraph?: { title?: string; description?: string }
}

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

const defaultNum = 5

export const google: Tool & { url: string } = {
	name: 'google',
	syntax: { usage: [`GOOGLE "search terms" [ { num: ${defaultNum} } ]`] },
	description: 'Search the web with Google (through Serper). Returns titles, URLs and snippets.',
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
	readOnly: true,
	card: { command: 'query' },
	url: 'https://google.serper.dev/search',
	async run(input, ctx) {
		let query = typeof input.query === 'string' ? input.query.trim() : ''
		if (!query) throw new Error('query must be a non-empty string')
		let num = Math.min(10, Math.max(1, Number.isInteger(input.num) ? (input.num as number) : defaultNum))
		let key = apiKeys.get('serper')
		if (!key) throw new Error('no Serper API key: set serper: { apiKey } in the credentials file')
		let res = await fetch(google.url, {
			method: 'POST',
			headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
			body: JSON.stringify({ q: query, num }),
			// A hung Serper must not hold the turn until Escape.
			signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
		})
		if (!res.ok) throw new Error(`Serper answered ${res.status}: ${(await res.text()).slice(0, 500)}`)
		return format((await res.json()) as Answer)
	},
}

export default (plugin: Plugin) => {
	plugin.around(tools, 'all', (next) => [...next(), google])
}
