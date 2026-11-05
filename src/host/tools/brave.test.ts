import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { auth } from '../auth.ts'
import { tool } from './brave.ts'
import { paths } from '../paths.ts'

let home = ''
const savedHome = paths.state.home
let origUrl = tool.url
let server: ReturnType<typeof Bun.serve>
let seen: { key: string | null; query: Record<string, string> }[] = []
let answer: () => Response = () => Response.json({})
const ctx = () => ({ cwd: home, signal: new AbortController().signal, sessionId: 's' })
const key = (k: string) => writeFileSync(`${home}/secrets/auth.ason`, `{ brave: { apiKey: '${k}' } }\n`)

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-brave-`)
	mkdirSync(`${home}/secrets`)
	paths.state.home = home
	seen = []
	server = Bun.serve({
		port: 0,
		fetch(req) {
			let query = Object.fromEntries(new URL(req.url).searchParams)
			seen.push({ key: req.headers.get('x-subscription-token'), query })
			return answer()
		},
	})
	tool.url = `http://127.0.0.1:${server.port}/search`
})

afterEach(() => {
	auth.close()
	server.stop(true)
	tool.url = origUrl
	paths.state.home = savedHome
	rmSync(home, { recursive: true, force: true })
})

test('formats hits as plain text; key from the credentials file', async () => {
	key('filekey')
	answer = () =>
		Response.json({
			web: {
				results: [
					{ title: 'A &amp; B', url: 'https://a', description: 'the <strong>bun</strong> runtime&#x27;s docs' },
					{ title: 'C', url: 'https://c', description: 'sc' },
				],
			},
		})
	let out = await tool.run({ query: ' bun ', num: 50 }, ctx())
	expect(out).toBe("A & B\nhttps://a\nthe bun runtime's docs\n\nC\nhttps://c\nsc")
	expect(seen).toEqual([{ key: 'filekey', query: { q: 'bun', count: '10' } }])
})

test('no key says where to set it and sends nothing; empty results say so', async () => {
	await expect(tool.run({ query: 'x' }, ctx())).rejects.toThrow(/credentials file/)
	expect(seen).toEqual([])
	key('k')
	answer = () => Response.json({ web: { results: [] } })
	expect(await tool.run({ query: 'x' }, ctx())).toBe('No results found.')
	expect(seen[0]!.query.count).toBe('5')
})

test('a non-2xx answer is an error with the status and a clipped body', async () => {
	key('k')
	answer = () => new Response('x'.repeat(2000), { status: 429 })
	let err = await tool.run({ query: 'x' }, ctx()).catch((e) => e.message as string)
	expect(err).toContain('429')
	expect(err.length).toBeLessThan(600)
})
