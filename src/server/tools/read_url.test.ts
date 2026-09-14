import { afterEach, expect, test } from 'bun:test'
import { toolRegistry } from './tool.ts'
import { builtins } from './builtins.ts'
import { readUrl } from './read_url.ts'
import { readFile, unlink } from 'fs/promises'

builtins.init()
const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

test('registers the read_url tool', () => {
	expect(toolRegistry.getTool('read_url')?.name).toBe('read_url')
})

test('extracts readable text from simple html', async () => {
	globalThis.fetch = (async () => new Response(`
		<html>
			<head><title>Example</title><style>.x{}</style></head>
			<body>
				<nav>ignore me</nav>
				<main>
					<h1>Hello world</h1>
					<p>This is a useful paragraph with enough words.</p>
				</main>
			</body>
		</html>
	`, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch

	const out = await readUrl.execute({ url: 'https://example.com' }, { sessionId: 's', cwd: process.cwd() })
	expect(out).toContain('# Example')
	expect(out).toContain('# Hello world')
	expect(out).toContain('This is a useful paragraph with enough words.')
	expect(out).not.toContain('ignore me')
})

test('returns Markdown responses without HTML extraction', async () => {
	globalThis.fetch = (async () => new Response('# API\n\nUseful documentation.\n', {
		headers: { 'content-type': 'text/markdown; charset=utf-8' },
	})) as unknown as typeof fetch

	const out = await readUrl.execute({ url: 'https://example.com/api.md' }, { sessionId: 's', cwd: process.cwd() })
	expect(out).toBe('# API\n\nUseful documentation.\n')
})

test('returns plain-text source files without HTML extraction', async () => {
	const source = 'export function identity<T>(value: T): T {\n\treturn value\n}\n'
	globalThis.fetch = (async () => new Response(source, {
		headers: { 'content-type': 'text/plain; charset=utf-8' },
	})) as unknown as typeof fetch

	const out = await readUrl.execute({ url: 'https://raw.githubusercontent.com/example/project/main/file.ts' }, { sessionId: 's', cwd: process.cwd() })
	expect(out).toBe(source)
})

test('returns supported images as native tool content', async () => {
	const image = Buffer.from('image bytes')
	globalThis.fetch = (async () => new Response(image, {
		headers: { 'content-type': 'image/png' },
	})) as unknown as typeof fetch

	const out = await readUrl.execute({ url: 'https://example.com/image.png' }, { sessionId: 's', cwd: process.cwd() })
	expect(out as unknown).toEqual([
		{ type: 'text', text: 'Read image from https://example.com/image.png [image/png]' },
		{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } },
	])
})

test('saves unsupported responses for other tools to inspect', async () => {
	const pdf = Buffer.from('%PDF-example')
	globalThis.fetch = (async () => new Response(pdf, {
		headers: { 'content-type': 'application/pdf' },
	})) as unknown as typeof fetch

	const out = await readUrl.execute({ url: 'https://example.com/report.pdf' }, { sessionId: 's', cwd: process.cwd() }) as string
	const path = out.match(/\/tmp\/hal-file-[\w-]+\.pdf/)?.[0]
	try {
		expect(path).toBeDefined()
		expect(await readFile(path!)).toEqual(pdf)
		expect(out).toContain('Cannot read report.pdf; saved it to')
	} finally {
		if (path) await unlink(path)
	}
})

test('rejects invalid urls', async () => {
	const out = await readUrl.execute({ url: 'nope' }, { sessionId: 's', cwd: process.cwd() })
	expect(out).toBe('error: invalid url')
})
