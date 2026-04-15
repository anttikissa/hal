import { afterEach, expect, test } from 'bun:test'
import { toolRegistry } from './tool.ts'
import { builtins } from './builtins.ts'
import { readUrl } from './read_url.ts'

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
	`)) as unknown as typeof fetch

	const out = await readUrl.execute({ url: 'https://example.com' }, { sessionId: 's', cwd: process.cwd() })
	expect(out).toContain('# Example')
	expect(out).toContain('# Hello world')
	expect(out).toContain('This is a useful paragraph with enough words.')
	expect(out).not.toContain('ignore me')
})

test('rejects invalid urls', async () => {
	const out = await readUrl.execute({ url: 'nope' }, { sessionId: 's', cwd: process.cwd() })
	expect(out).toBe('error: invalid url')
})
