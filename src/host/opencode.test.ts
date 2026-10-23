// OpenCode Go: /login opencode stores an API key; requests carry it
// (stored first, OPENCODE_API_KEY next) and the headers OpenCode asks
// for. A fake Chat Completions server and a temp home only.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
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
import { paths } from './paths.ts'

const savedHome = paths.state.home
const saved = { OPENCODE_API_KEY: process.env.OPENCODE_API_KEY }
const orig = { endpoints: openaiCompat.endpoints, pollMs: auth.pollMs, onError: liveFiles.onError }
let home = ''
let server: ReturnType<typeof Bun.serve>
let seen: Headers[] = []
let routes: string[] = []

// Trimmed from the real gateway's streams, one per protocol.
function stream(path: string): string {
	let sse = (events: unknown[]) =>
		events.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')
	if (path.endsWith('/responses'))
		return sse([
			{ type: 'response.output_text.delta', delta: 'ok' },
			{ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 1 } } },
		])
	if (path.endsWith('/messages'))
		return sse([
			{ type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
			{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
			{ type: 'content_block_stop', index: 0 },
			{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 1 } },
			{ type: 'message_stop' },
		])
	return sse([
		{ choices: [{ delta: { content: 'ok' } }] },
		{ choices: [{ delta: {}, finish_reason: 'stop' }] },
		'[DONE]',
	])
}

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-opencode-`)
	mkdirSync(`${home}/secrets`)
	paths.state.home = home
	delete process.env.OPENCODE_API_KEY
	seen = []
	routes = []
	server = Bun.serve({
		port: 0,
		fetch(req) {
			seen.push(req.headers)
			routes.push(new URL(req.url).pathname)
			return new Response(stream(new URL(req.url).pathname))
		},
	})
	// The real endpoint, pointed at the fake server.
	let real = orig.endpoints()['opencode-go']!
	openaiCompat.endpoints = () => ({
		'opencode-go': { ...real, baseUrl: `http://127.0.0.1:${server.port}/inference/go/openai/v1` },
	})
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
	paths.state.home = savedHome
	for (let [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k]
		else process.env[k] = v
	}
	rmSync(home, { recursive: true, force: true })
})

const ctx = { sessionId: 's', cwd: '/tmp', model: 'opencode-go/m', setCwd() {}, setModel() {}, say() {} }
const file = () => `${home}/secrets/auth.ason`

async function send(sessionId?: string, model = 'm'): Promise<{ events: string[]; message?: string }> {
	let out: string[] = []
	let message: string | undefined
	for await (let e of provider.stream(`opencode-go/${model}`, {
		messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }],
		sessionId,
	})) {
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

test('opencode-go keys are accounts that rotate on limits', async () => {
	let { limits } = await import('./limits.ts')
	let { apiKeys } = await import('./api-keys.ts')
	paths.init()
	try {
		writeFileSync(file(), ason.stringify({ 'opencode-go': { apiKey: 'k1' } }), { mode: 0o600 })
		apiKeys.save('opencode-go', 'k2')
		apiKeys.save('opencode-go', 'k2')
		expect((ason.parse(readFileSync(file(), 'utf8')) as any)['opencode-go']).toEqual([
			{ apiKey: 'k1' },
			{ apiKey: 'k2' },
		])
		// An account-less limit blocks none.
		limits.set(limits.key('opencode-go/m'), Date.now() + 3600_000)
		let first = await auth.pick('opencode-go', 'm')
		expect(first.value).toBe('k1')
		limits.set(limits.key('opencode-go', first.account), Date.now() + 3600_000)
		let second = await auth.pick('opencode-go', 'm')
		expect(second.value).toBe('k2')
		expect(auth.limitedUntil('opencode-go/m')).toBe(0)
		// 23 Oct 2026: removing a key shifted positions, moving its limit onto another key.
		writeFileSync(file(), ason.stringify({ 'opencode-go': [{ apiKey: 'k2' }] }), { mode: 0o600 })
		auth.close()
		expect(await auth.pick('opencode-go', 'm')).toMatchObject({ value: 'k2', account: second.account })
	} finally {
		limits.close()
	}
})

test('an empty key stores nothing', async () => {
	expect((await command.run('opencode', { key: '  ' }, ctx)).error).toBeDefined()
	expect((await send()).message).toContain('/login opencode')
})

test('a session blocked for want of a key takes /login opencode and continues, sending its id and User-Agent hal', async () => {
	auth.pollMs = 5
	let events: Event[] = []
	let conn = host.connect((e) => events.push(e))
	let until = async (check: () => unknown) => {
		for (let i = 0; i < 5000 && !check(); i++) await Bun.sleep(2)
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

// Invariant: each model goes to the protocol models.dev names for it,
// with the rotating account's key; the gateway refuses other protocols.
test('models.dev routes each model to Responses, Messages or Chat Completions, with the account key', async () => {
	let info = modelsDev.info
	let npm: Record<string, string> = { 'opencode-go/grok': '@ai-sdk/openai', 'opencode-go/minimax': '@ai-sdk/anthropic' }
	modelsDev.info = (id: string) => (npm[id] ? { npm: npm[id] } : undefined)
	writeFileSync(file(), ason.stringify({ 'opencode-go': [{ apiKey: 'k1' }] }), { mode: 0o600 })
	try {
		for (let model of ['grok', 'minimax', 'glm'])
			expect((await send('s1', model)).events.filter((t) => t !== 'usage')).toEqual(['text', 'done'])
	} finally {
		modelsDev.info = info
	}
	expect(routes).toEqual([
		'/inference/go/openai/v1/responses',
		'/inference/go/anthropic/v1/messages',
		'/inference/go/openai/v1/chat/completions',
	])
	expect(seen.map((h) => h.get('authorization') ?? h.get('x-api-key'))).toEqual(['Bearer k1', 'k1', 'Bearer k1'])
	expect(seen.every((h) => h.get('x-opencode-session') === 's1')).toBe(true)
})
