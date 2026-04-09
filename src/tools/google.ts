// Google search tool — uses Serper.dev's Google Search API.
//
// Reads API key from auth.ason (serper.apiKey) or SERPER_API_KEY env var.
// Returns organic results with title, link, and snippet for each hit.

import { toolRegistry, type ToolContext } from './tool.ts'
import { auth } from '../auth.ts'

const SERPER_URL = 'https://google.serper.dev/search'

interface SerperResult {
	title: string
	link: string
	snippet: string
}

interface SerperResponse {
	organic?: SerperResult[]
	answerBox?: { answer?: string; snippet?: string; title?: string }
	knowledgeGraph?: { title?: string; description?: string }
}

async function execute(input: any, _ctx: ToolContext): Promise<string> {
	const query = String(input?.query ?? '').trim()
	if (!query) return 'error: query is required'

	const cred = auth.getCredential('serper')
	if (!cred) return 'error: no Serper API key. Set serper.apiKey in auth.ason or SERPER_API_KEY env var.'

	const numResults = Math.min(input?.num ?? 5, 10)

	const res = await fetch(SERPER_URL, {
		method: 'POST',
		headers: {
			'X-API-KEY': cred.value,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ q: query, num: numResults }),
	})

	if (!res.ok) {
		const body = await res.text()
		return `error: Serper API returned ${res.status}: ${body.slice(0, 500)}`
	}

	const data = (await res.json()) as SerperResponse
	const parts: string[] = []

	// Include answer box if present.
	if (data.answerBox) {
		const ab = data.answerBox
		const answer = ab.answer || ab.snippet || ''
		if (answer) parts.push(`Answer: ${answer}`)
	}

	// Include knowledge graph if present.
	if (data.knowledgeGraph?.description) {
		parts.push(`${data.knowledgeGraph.title || ''}: ${data.knowledgeGraph.description}`)
	}

	// Organic results.
	if (data.organic?.length) {
		for (const r of data.organic) {
			parts.push(`${r.title}\n${r.link}\n${r.snippet}`)
		}
	}

	if (!parts.length) return 'No results found.'
	return parts.join('\n\n')
}

toolRegistry.registerTool({
	name: 'google',
	description: 'Google a query using Serper. Returns titles, URLs, and snippets.',
	parameters: {
		query: { type: 'string', description: 'Search query' },
		num: { type: 'integer', description: 'Number of results (default: 5, max: 10)' },
	},
	required: ['query'],
	execute,
})

export const google = { execute }
