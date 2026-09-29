import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { auth } from '../auth.ts'
import { tool } from './google.ts'

let home = ''
let saved = { HAL_HOME: process.env.HAL_HOME, SERPER_API_KEY: process.env.SERPER_API_KEY }
let origUrl = tool.url
let server: ReturnType<typeof Bun.serve>
let seen: { key: string | null; body: any }[] = []
let answer: () => Response = () => Response.json({})
const ctx = () => ({ cwd: home, signal: new AbortController().signal, sessionId: 's' })

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-google-`)
	process.env.HAL_HOME = home
	delete process.env.SERPER_API_KEY
	seen = []
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			seen.push({ key: req.headers.get('x-api-key'), body: await req.json() })
			return answer()
		},
	})
	tool.url = () => `http://127.0.0.1:${server.port}/search`
})

afterEach(() => {
	auth.close()
	server.stop(true)
	tool.url = origUrl
	for (let [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k]
		else process.env[k] = v
	}
	rmSync(home, { recursive: true, force: true })
})

test('formats answer box, knowledge graph and hits; key from the credentials file', async () => {
	writeFileSync(`${home}/auth.ason`, "{ serper: { apiKey: 'filekey' } }\n")
	process.env.SERPER_API_KEY = 'envkey'
	answer = () =>
		Response.json({
			answerBox: { answer: '42' },
			knowledgeGraph: { title: 'Bun', description: 'A runtime' },
			organic: [
				{ title: 'A', link: 'https://a', snippet: 'sa' },
				{ title: 'B', link: 'https://b', snippet: 'sb' },
			],
		})
	let out = await tool.run({ query: ' bun ', num: 50 }, ctx())
	expect(out).toBe('Answer: 42\n\nBun: A runtime\n\nA\nhttps://a\nsa\n\nB\nhttps://b\nsb')
	expect(seen).toEqual([{ key: 'filekey', body: { q: 'bun', num: 10 } }])
})

test('no key names both places and sends nothing; then SERPER_API_KEY serves, and empty results say so', async () => {
	await expect(tool.run({ query: 'x' }, ctx())).rejects.toThrow(/credentials file.*SERPER_API_KEY/)
	expect(seen).toEqual([])
	process.env.SERPER_API_KEY = 'envkey'
	answer = () => Response.json({ organic: [] })
	expect(await tool.run({ query: 'x' }, ctx())).toBe('No results found.')
	expect(seen[0]).toEqual({ key: 'envkey', body: { q: 'x', num: 5 } })
})

test('a non-2xx answer is an error with the status and a clipped body', async () => {
	process.env.SERPER_API_KEY = 'k'
	answer = () => new Response('x'.repeat(2000), { status: 403 })
	let err = await tool.run({ query: 'x' }, ctx()).catch((e) => e.message as string)
	expect(err).toContain('403')
	expect(err.length).toBeLessThan(600)
})
