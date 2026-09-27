// OpenCode Go: /login opencode stores an API key; requests carry it
// (stored first, OPENCODE_API_KEY next) and the headers OpenCode asks
// for. A fake Chat Completions server and a temp HAL_HOME only.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import type { Event } from '../common/protocol.ts'
import { auth } from './auth.ts'
import { command } from './commands/login.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { liveFiles } from './live-file.ts'
import { models } from './models.ts'
import { modelsDev } from './models-dev.ts'
import { openaiCompat } from './openai-compat.ts'
import { provider } from './provider.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'

const saved = { HAL_HOME: process.env.HAL_HOME, OPENCODE_API_KEY: process.env.OPENCODE_API_KEY }
const orig = { endpoints: openaiCompat.endpoints, pollMs: auth.pollMs, onError: liveFiles.onError }
let home = ''
let server: ReturnType<typeof Bun.serve>
let seen: Headers[] = []

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-opencode-`)
	process.env.HAL_HOME = home
	delete process.env.OPENCODE_API_KEY
	seen = []
	server = Bun.serve({
		port: 0,
		fetch(req) {
			seen.push(req.headers)
			let chunks = [{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']
			return new Response(chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join(''))
		},
	})
	// The real endpoint, pointed at the fake server.
	let real = orig.endpoints()['opencode-go']!
	openaiCompat.endpoints = () => ({ 'opencode-go': { ...real, baseUrl: `http://127.0.0.1:${server.port}/v1` } })
	openaiCompat.init()
	liveFiles.onError = () => {}
})

afterEach(() => {
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	auth.close()
	server.stop(true)
	Object.assign(openaiCompat, { endpoints: orig.endpoints })
	Object.assign(auth, { pollMs: orig.pollMs })
	liveFiles.onError = orig.onError
	for (let [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k]
		else process.env[k] = v
	}
	rmSync(home, { recursive: true, force: true })
})

const ctx = { sessionId: 's', cwd: '/tmp', model: 'opencode-go/m', setCwd() {}, setModel() {} }
const file = () => `${home}/auth.ason`

async function send(sessionId?: string): Promise<{ events: string[]; message?: string }> {
	let out: string[] = []
	let message: string | undefined
	for await (let e of provider.stream('opencode-go/m', { messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }], sessionId })) {
		out.push(e.type)
		if (e.type === 'error') message = e.message
	}
	return { events: out, message }
}

test('the stored key comes first, OPENCODE_API_KEY next; with neither the error names both ways', async () => {
	let none = await send()
	expect(none.message).toContain('/login opencode')
	expect(none.message).toContain('OPENCODE_API_KEY')
	expect(seen).toHaveLength(0)

	process.env.OPENCODE_API_KEY = 'env-key'
	expect((await send()).events).toEqual(['text', 'done'])
	expect(seen[0]!.get('authorization')).toBe('Bearer env-key')

	writeFileSync(file(), ason.stringify({ anthropic: { apiKey: 'claude-key' } }), { mode: 0o600 })
	for (let alias of ['opencode', 'opencode-go']) {
		let ask = await command.run(alias, undefined, ctx)
		expect(ask.ask!.fields).toEqual([expect.objectContaining({ type: 'secret' })])
	}
	expect((await command.run('opencode', { key: ' stored-key \n' }, ctx)).say).toBeDefined()
	await send()
	expect(seen[1]!.get('authorization')).toBe('Bearer stored-key')
	// Other logins in the file stay; the file stays private.
	expect(ason.parse(readFileSync(file(), 'utf8'))).toMatchObject({ anthropic: { apiKey: 'claude-key' } })
	expect(statSync(file()).mode & 0o777).toBe(0o600)
})

test('an empty key stores nothing', async () => {
	expect((await command.run('opencode', { key: '  ' }, ctx)).error).toBeDefined()
	expect((await send()).message).toContain('/login opencode')
})

test('a session blocked for want of a key takes /login opencode and continues, sending its id and User-Agent hal', async () => {
	auth.pollMs = () => 5
	let events: Event[] = []
	let conn = host.connect((e) => events.push(e))
	let until = async (check: () => unknown) => {
		for (let i = 0; i < 1000 && !check(); i++) await Bun.sleep(2)
		if (!check()) throw new Error('timed out')
	}
	conn.send({ type: 'create', cwd: '/tmp', model: 'opencode-go/m' })
	let id = (events.find((e) => e.type === 'snapshot') as any).sessionId
	conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => status.stateOf(id).type === 'blocked')
	expect((status.stateOf(id) as any).reason).toContain('/login opencode')

	conn.send({ type: 'submit', sessionId: id, text: '/login opencode' })
	await until(() => events.some((e) => e.type === 'question'))
	let q = events.find((e) => e.type === 'question') as any
	conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { key: 'secret-key-123' } })
	await until(() => events.some((e) => e.type === 'turn-end'))
	expect(events.find((e) => e.type === 'turn-end')).toMatchObject({ status: 'completed' })
	expect(seen[0]!.get('authorization')).toBe('Bearer secret-key-123')
	expect(seen[0]!.get('user-agent')).toBe('hal')
	expect(seen[0]!.get('x-opencode-session')).toBe(id)
	expect(readFileSync(history.file(id), 'utf8')).not.toContain('secret-key-123')
})

test('the model list comes from models.dev, without asking the server', async () => {
	let ids = modelsDev.ids
	modelsDev.ids = (name: string) => (name === 'opencode-go' ? ['glm-5', 'kimi-k2'] : [])
	try {
		expect(await models.fetchList('opencode-go')).toEqual(['opencode-go/glm-5', 'opencode-go/kimi-k2'])
	} finally {
		modelsDev.ids = ids
	}
	expect(seen).toHaveLength(0)
})
