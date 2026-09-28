import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { attachments } from '../../common/attachments.ts'
import { paths } from '../paths.ts'
import { tools } from '../tools.ts'
import { tool } from './read_url.ts'

let home: string
let server: ReturnType<typeof Bun.serve>
let requested: string[]
let previous = process.env.HAL_HOME
let response: (req: Request) => Response
const ctx = () => ({ cwd: home, sessionId: 's', signal: new AbortController().signal })
const url = (path = '/') => `http://127.0.0.1:${server.port}${path}`

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-url-`)
	process.env.HAL_HOME = home
	mkdirSync(paths.sessionDir('s'), { recursive: true })
	requested = []
	response = () => new Response('ok')
	server = Bun.serve({ port: 0, fetch(req) { requested.push(new URL(req.url).pathname); return response(req) } })
})
afterEach(() => {
	server.stop(true)
	if (previous === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = previous
	rmSync(home, { recursive: true, force: true })
})

test('HTML title, blocks, entities and redirects; plain text and JSON pass through', async () => {
	response = (req) => new URL(req.url).pathname === '/redirect' ? Response.redirect(url('/page')) : new Response('<html><head><title>A &amp; B</title><style>secret</style></head><body><h2>Hello</h2><p>One&nbsp;two &#65;<br>next</p><script>evil()</script></body></html>', { headers: { 'content-type': 'text/html' } })
	let out = await tool.run({ url: url('/redirect') }, ctx())
	expect(out).toBe('A & B\n\nHello\n\nOne two A\nnext')
	expect(requested).toEqual(['/redirect', '/page'])
	response = () => new Response(' {"ok": true}\n', { headers: { 'content-type': 'application/json' } })
	expect(await tool.run({ url: url() }, ctx())).toBe(' {"ok": true}\n')
	response = () => new Response('a\n  b\n', { headers: { 'content-type': 'text/plain' } })
	expect(await tool.run({ url: url() }, ctx())).toBe('a\n  b\n')
})

test('bad schemes and HTTP errors cannot masquerade as successful content', async () => {
	for (let bad of ['file:///etc/passwd', 'data:text/plain,hi', 'javascript:alert(1)']) await expect(tool.run({ url: bad }, ctx())).rejects.toThrow(/http or https/)
	expect(requested).toEqual([])
	response = () => new Response('Denied', { status: 403 })
	let result = await tools.run({ type: 'tool_call', id: '1', name: 'read_url', input: { url: url() } }, ctx())
	expect(result.isError).toBe(true)
	expect(result.output).toContain('403')
})

test('large text says how many characters were cut', async () => {
	response = () => new Response('x'.repeat(55_000), { headers: { 'content-type': 'text/plain' } })
	let result = await tools.run({ type: 'tool_call', id: '1', name: 'read_url', input: { url: url() } }, ctx())
	expect(result.output.length).toBeLessThanOrEqual(tools.maxChars())
	let cut = Number(result.output.match(/\[output truncated: (\d+) more characters\]/)?.[1])
	expect(result.output.startsWith('x'.repeat(1000))).toBe(true)
	expect(result.output.slice(0, 55_000 - cut)).toBe('x'.repeat(55_000 - cut))
})

test('image is a stored image result replayable to Anthropic, not base64 history', async () => {
	let png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
	response = () => new Response(png, { headers: { 'content-type': 'image/png' } })
	let result = await tools.run({ type: 'tool_call', id: '1', name: 'read_url', input: { url: url() } }, ctx())
	expect(result.image).toMatchObject({ type: 'image', mediaType: 'image/png', bytes: png.length })
	expect(result.output).not.toContain(png.toString('base64'))
	let { anthropic } = await import('../anthropic.ts')
	let { blobs } = await import('../blobs.ts')
	let messages = anthropic.toMessages({ model: 'claude-test', messages: [{ role: 'assistant', blocks: [{ type: 'tool_call', id: '1', name: 'read_url', input: {} }] }, { role: 'user', blocks: [result] }], image: (id) => blobs.base64('s', id) })
	expect(messages[1].content[0].content[1].source.data).toBe(png.toString('base64'))
	response = () => new Response(Buffer.alloc(attachments.maxBytes() + 1), { headers: { 'content-type': 'image/png' } })
	let huge = await tools.run({ type: 'tool_call', id: '2', name: 'read_url', input: { url: url() } }, ctx())
	expect(huge.isError).toBe(true)
})

test('binary downloads go in the download directory with path, type and size', async () => {
	response = () => new Response(Uint8Array.of(0, 1, 2), { headers: { 'content-type': 'application/pdf' } })
	let out = await tool.run({ url: url('/report.pdf') }, ctx())
	expect(typeof out).toBe('string')
	let path = (out as string).match(/to (\S+\.pdf) \(application\/pdf, 3 bytes\)/)?.[1]
	expect(path?.startsWith(`${paths.fileDir()}/`)).toBe(true)
	expect(existsSync(path!)).toBe(true)
	expect(readFileSync(path!)).toEqual(Buffer.from([0, 1, 2]))
})

test('an endless text body is read only up to its limit, and the cut is said', async () => {
	let limit = tool.maxTextBytes
	tool.maxTextBytes = () => 100_000
	let pulls = 0
	response = () => new Response(new ReadableStream({ pull: (c) => { pulls++; c.enqueue(new TextEncoder().encode('y'.repeat(10_000))) } }), { headers: { 'content-type': 'text/plain' } })
	try {
		let out = await tool.run({ url: url() }, ctx())
		expect(out).toContain('more than 100000 bytes')
		expect(pulls).toBeLessThan(1000)
	} finally {
		tool.maxTextBytes = limit
	}
})
