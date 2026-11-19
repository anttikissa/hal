import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { nativeTool } from './native-tool.ts'
import { mcp } from './mcp.ts'
import { paths } from './paths.ts'
import { tools } from './tools.ts'

// A fake MCP server over stdio, one JSON message per line.
const fake = `
let cancelled = [], waiting
let send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
let text = (id, t, extra) => send({ id, result: { content: [{ type: 'text', text: t }], ...extra } })
let buffer = ''
process.stdin.on('data', (d) => {
	buffer += d
	let lines = buffer.split('\\n')
	buffer = lines.pop()
	for (let line of lines) handle(JSON.parse(line))
})
function handle(m) {
	if (m.id === 'p') return text(waiting, 'pong ' + JSON.stringify(m.result))
	if (m.method === 'notifications/cancelled') return cancelled.push(m.params.requestId)
	if (m.id === undefined) return
	if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
	if (m.method === 'tools/list' && !m.params.cursor)
		return send({ id: m.id, result: { nextCursor: 'p2', tools: [{ name: 'echo', description: 'Echoes.\\nMore.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to say' }, n: { type: 'array', items: { type: 'number' } } }, required: ['text'] } }] } })
	if (m.method === 'tools/list')
		return send({ id: m.id, result: { tools: ['shot', 'fail', 'crash', 'slow', 'ping', 'cancelled'].map((name) => ({ name, inputSchema: { type: 'object' } })) } })
	let { name, arguments: args } = m.params
	if (name === 'echo') return text(m.id, args.text)
	if (name === 'shot') return send({ id: m.id, result: { content: [{ type: 'text', text: 'here' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAAA' }] } })
	if (name === 'fail') return text(m.id, 'no such page', { isError: true })
	if (name === 'crash') { process.stderr.write('boom\\n'); process.exit(3) }
	if (name === 'ping') { waiting = m.id; return send({ id: 'p', method: 'ping' }) }
	if (name === 'cancelled') return text(m.id, JSON.stringify(cancelled))
}
`

let home = ''
const savedHome = paths.state.home
const signal = new AbortController().signal
let server: ReturnType<typeof Bun.serve>
let sessions = new Set<string>()

const run = async (cmd: string, s = signal) => {
	let { name, input } = nativeTool.resolve(cmd)
	return tools.run({ type: 'tool_call', id: 'c', name, input }, { cwd: home, sessionId: 's', signal: s })
}

beforeAll(() => {
	home = mkdtempSync(`${tmpdir()}/hal-mcp-`)
	paths.state.home = home
	writeFileSync(`${home}/fake.js`, fake)
	// A streamable HTTP server: SSE replies, and a session it can forget.
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method === 'DELETE') return new Response(null, { status: 204 })
			let m = await req.json()
			let id = req.headers.get('mcp-session-id')
			if (m.method === 'initialize') {
				let session = crypto.randomUUID()
				sessions.add(session)
				let result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'h', version: '1' } }
				return Response.json({ jsonrpc: '2.0', id: m.id, result }, { headers: { 'Mcp-Session-Id': session } })
			}
			if (!id || !sessions.has(id)) return new Response('unknown session', { status: 404 })
			if (m.id === undefined) return new Response(null, { status: 202 })
			let result =
				m.method === 'tools/list'
					? { tools: [{ name: 'who', inputSchema: { type: 'object' } }] }
					: { content: [{ type: 'text', text: `auth ${req.headers.get('authorization')}` }] }
			let body = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`
			return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
		},
	})
	process.env.HAL_MCP_TEST_TOKEN = 'Bearer t0'
	writeFileSync(
		`${home}/mcp.ason`,
		`{ mcpServers: {
			fake: { command: '${process.execPath}', args: ['${home}/fake.js'], timeout: 0.5 },
			web: { url: 'http://127.0.0.1:${server.port}/mcp', headers: { Authorization: '\${HAL_MCP_TEST_TOKEN}' } },
			off: { command: 'false', enabled: false },
		} }`,
	)
})
afterEach(() => mcp.stopAll())
afterAll(() => {
	server.stop(true)
	paths.state.home = savedHome
	rmSync(home, { recursive: true, force: true })
})

test('lists servers and paginated tools with signatures; describes one tool', async () => {
	expect((await run('MCP')).output).toContain('fake: not started')
	let listed = (await run('MCP "fake"')).output
	expect(listed).toContain('echo(text: string, n?: number[])\n  Echoes.')
	expect(listed).toContain('cancelled()')
	expect((await run('MCP')).output).toContain('fake: running, 7 tools')
	let described = (await run('MCP "fake.echo"')).output
	expect(described).toContain('Echoes.\nMore.')
	expect(described).toContain('text: What to say')
	expect((await run('MCP "off"')).output).toContain('off is disabled')
})

test('calls return text, images and tool errors; server pings are answered', async () => {
	expect((await run('MCP "fake.echo" { text: "hi" }')).output).toBe('hi')
	let shot = await run('MCP "fake.shot" {}')
	expect(shot.output).toBe('here')
	expect(shot.images ?? [shot.image]).toHaveLength(1)
	let failed = await run('MCP "fake.fail" {}')
	expect(failed.isError).toBe(true)
	expect(failed.output).toContain('no such page')
	expect((await run('MCP "fake.ping" {}')).output).toBe('pong {}')
	expect((await run('MCP "fake.nope" {}')).output).toContain('fake has no tool nope; it has: echo, shot')
})

test('a crash reports stderr and the next call restarts the server', async () => {
	let crashed = await run('MCP "fake.crash" {}')
	expect(crashed.isError).toBe(true)
	expect(crashed.output).toContain('fake exited with code 3')
	expect(crashed.output).toContain('boom')
	expect((await run('MCP "fake.echo" { text: "back" }')).output).toBe('back')
})

test('aborting a call tells the server; a hung call times out', async () => {
	let abort = new AbortController()
	let call = run('MCP "fake.slow" {}', abort.signal)
	await Bun.sleep(100)
	abort.abort()
	expect((await call).isError).toBe(true)
	let timedOut = await run('MCP "fake.slow" {}')
	expect(timedOut.output).toContain('fake did not answer tools/call in 0.5 s')
	let ids = JSON.parse((await run('MCP "fake.cancelled" {}')).output)
	expect(ids).toHaveLength(2)
})

test('HTTP: env-expanded headers, SSE replies and a new session after expiry', async () => {
	expect((await run('MCP "web.who" {}')).output).toBe('auth Bearer t0')
	sessions.clear()
	expect((await run('MCP "web.who" {}')).output).toBe('auth Bearer t0')
})
