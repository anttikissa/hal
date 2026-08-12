// Read URL tool — fetch a web page and pull out readable text.
//
// This stays tiny on purpose. It is only meant as a simple first pass.

import { toolRegistry, type Tool, type ToolContext } from './tool.ts'

const MAX_OUTPUT = 100_000

interface ReadUrlInput {
	url?: string
}

function normalizeInput(input: unknown): ReadUrlInput {
	const raw = toolRegistry.inputObject(input)
	return {
		url: raw.url === undefined ? undefined : String(raw.url),
	}
}

function cleanText(s: string): string {
	return s
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/<[^>]+>/g, '')
		.replace(/\s+/g, ' ')
		.trim()
}

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	const spec = normalizeInput(input)
	const rawUrl = (spec.url ?? '').trim()
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		return 'error: invalid url'
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'error: invalid url'

	const raw = await fetch(url, { signal: ctx.signal }).then((r) => r.text())
	let html = raw
	for (const tag of ['main', 'article']) {
		const m = raw.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
		if (m) {
			html = m[1]!
			break
		}
	}

	html = html
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<nav[\s\S]*?<\/nav>/gi, '')
		.replace(/<header[\s\S]*?<\/header>/gi, '')
		.replace(/<footer[\s\S]*?<\/footer>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '')

	const title = cleanText(raw.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] ?? '')
	const blocks: string[] = []
	const re = /<(p|h[1-6]|li|td|th|blockquote|pre|code)[^>]*>([\s\S]*?)<\/\1>/gi
	for (const m of html.matchAll(re)) {
		const tag = m[1]!.toLowerCase()
		const text = cleanText(m[2]!)
		if (text.length < 15 && !tag.startsWith('h')) continue
		blocks.push((tag.startsWith('h') ? '#'.repeat(Number(tag[1])) + ' ' : '') + text)
	}

	const out = (title ? `# ${title}\n\n` : '') + blocks.join('\n\n')
	if (out.length <= MAX_OUTPUT) return out || 'error: no readable content found'
	return out.slice(0, MAX_OUTPUT) + '\n[… truncated]'
}

const readUrlTool: Tool = {
	name: 'read_url',
	description: 'Read a web page and extract simple readable text from HTML.',
	parameters: {
		url: { type: 'string', description: 'HTTP or HTTPS URL to read' },
	},
	required: ['url'],
	execute,
}

function init(): void {
	toolRegistry.registerTool(readUrlTool)
}

export const readUrl = { execute, init }
