// /login claude and API keys from the environment. Fake token and
// profile endpoints, a temp HAL_HOME; never the real credentials file.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import type { StreamEvent } from '../common/blocks.ts'
import type { Event } from '../common/protocol.ts'
import { auth } from './auth.ts'
import { command } from './commands/login.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { liveFiles } from './live-file.ts'
import { login } from './login.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { turns } from './turns.ts'

const saved = { HAL_HOME: process.env.HAL_HOME, HOME: process.env.HOME, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
const orig = { tokenUrl: auth.tokenUrl, profileUrl: login.profileUrl, pollMs: auth.pollMs, stream: turns.stream, onError: liveFiles.onError }
let home = ''
let server: ReturnType<typeof Bun.serve>
let tokenRequests: any[] = []
let tokenReply: () => Response
let profileEmail: string | undefined

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-login-`)
	process.env.HAL_HOME = home
	process.env.HOME = `${home}/user`
	delete process.env.ANTHROPIC_API_KEY
	tokenRequests = []
	profileEmail = 'a@example.com'
	tokenReply = () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (new URL(req.url).pathname === '/profile') {
				if (req.headers.get('authorization') !== 'Bearer new-access') return new Response('no', { status: 401 })
				return Response.json({ account: profileEmail ? { email: profileEmail } : {} })
			}
			tokenRequests.push(await req.json())
			return tokenReply()
		},
	})
	auth.tokenUrl = () => `http://127.0.0.1:${server.port}/token`
	login.profileUrl = () => `http://127.0.0.1:${server.port}/profile`
	liveFiles.onError = () => {}
})

afterEach(() => {
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	auth.close()
	server.stop(true)
	Object.assign(auth, { tokenUrl: orig.tokenUrl, pollMs: orig.pollMs })
	Object.assign(login, { profileUrl: orig.profileUrl })
	Object.assign(turns, { stream: orig.stream })
	liveFiles.onError = orig.onError
	for (let [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k]
		else process.env[k] = v
	}
	rmSync(home, { recursive: true, force: true })
})

const file = () => `${home}/auth.ason`
const disk = () => ason.parse(readFileSync(file(), 'utf8')) as any
const ctx = { sessionId: 's', cwd: '/tmp', model: 'anthropic/m', setCwd() {}, setModel() {}, say() {} }

// The code#state value the Claude page would show for the URL asked with.
async function pastedCode(code = 'the-code'): Promise<string> {
	let reply = await command.run('claude', undefined, ctx)
	let field = reply.ask!.fields[0]!
	expect(field.type).toBe('secret')
	let url = new URL(/https:\S+/.exec(reply.ask!.text)![0])
	return `${code}#${url.searchParams.get('state')}`
}

async function error(run: () => Promise<unknown>): Promise<Error> {
	try {
		await run()
	} catch (e) {
		return e as Error
	}
	throw new Error('expected a failure')
}

test('/login claude asks for the code, exchanges it and writes this home a working login, 0600', async () => {
	let code = await pastedCode()
	let verifier = code.split('#')[1]
	let reply = await command.run('claude', { code }, ctx)
	expect(reply.say).toContain('a@example.com')
	expect(tokenRequests).toEqual([expect.objectContaining({ grant_type: 'authorization_code', code: 'the-code', code_verifier: verifier })])
	expect(statSync(file()).mode & 0o777).toBe(0o600)
	expect(disk().anthropic).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh', email: 'a@example.com' })
	expect(await auth.anthropic()).toMatchObject({ type: 'token', value: 'new-access', account: 'a@example.com' })
})

test('the challenge in the URL is the hash of the verifier the code brings back', async () => {
	let reply = await command.run('claude', undefined, ctx)
	let url = new URL(/https:\S+/.exec(reply.ask!.text)![0])
	let verifier = url.searchParams.get('state')!
	let hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
	let expected = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
	expect(url.searchParams.get('code_challenge')).toBe(expected)
	expect(url.searchParams.get('code_challenge_method')).toBe('S256')
	// A fresh verifier each time.
	let again = new URL(/https:\S+/.exec((await command.run('claude', undefined, ctx)).ask!.text)![0])
	expect(again.searchParams.get('state')).not.toBe(verifier)
})

test('a login replaces the account with the same email and adds any other, keeping copied ones', async () => {
	writeFileSync(file(), ason.stringify({ anthropic: [{ accessToken: 'copied', refreshToken: 'r', email: 'b@example.com' }, { accessToken: 'old', refreshToken: 'r', email: 'a@example.com', plan: 'max' }] }), { mode: 0o600 })
	await command.run('claude', { code: await pastedCode() }, ctx)
	expect(disk().anthropic).toEqual([
		{ accessToken: 'copied', refreshToken: 'r', email: 'b@example.com' },
		expect.objectContaining({ accessToken: 'new-access', email: 'a@example.com', plan: 'max' }),
	])
	profileEmail = 'c@example.com'
	await command.run('claude', { code: await pastedCode() }, ctx)
	expect(disk().anthropic.map((e: any) => e.email)).toEqual(['b@example.com', 'a@example.com', 'c@example.com'])
})

test('a bad code or a refused exchange is an error that never echoes the code, and writes nothing', async () => {
	for (let code of ['', 'no-hash', 'a#short', 'a#b#c']) {
		let e = await error(() => command.run('claude', { code }, ctx) as Promise<unknown>)
		expect(e.message).toContain('code#state')
	}
	expect(tokenRequests).toHaveLength(0)
	tokenReply = () => Response.json({ error: 'invalid_grant', error_description: 'bad secret-code' }, { status: 400 })
	let e = await error(async () => command.run('claude', { code: await pastedCode('secret-code') }, ctx))
	expect(e.message).toContain('invalid_grant')
	expect(e.message).not.toContain('secret-code')
	expect(existsSync(file())).toBe(false)
})

test('/login asks for a method; choosing one continues to a secret form without losing other accounts', async () => {
	let first = await command.run('', undefined, ctx)
	expect(first.ask?.fields[0]).toMatchObject({ type: 'choice', name: 'method', options: expect.arrayContaining(['Claude subscription', 'ChatGPT subscription', 'Claude API key', 'ChatGPT API key', 'OpenCode API key', 'OpenRouter API key']) })
	writeFileSync(file(), ason.stringify({ anthropic: { accessToken: 'subscription', refreshToken: 'refresh', email: 'a@example.com' } }), { mode: 0o600 })
	let picked = await command.run('', { method: 'Claude API key' }, ctx)
	expect(picked.ask?.fields[0]).toMatchObject({ type: 'secret', name: 'key' })
	expect(picked.askArgs).toBe('anthropic-key')
	await command.run(picked.askArgs!, { key: 'my-key' }, ctx)
	expect(disk().anthropic).toEqual([expect.objectContaining({ accessToken: 'subscription', refreshToken: 'refresh' }), { apiKey: 'my-key' }])
	await command.run(picked.askArgs!, { key: 'new-key' }, ctx)
	expect(disk().anthropic).toHaveLength(2)
	expect(auth.all('anthropic').list.map((a) => a.entry)).toEqual([expect.objectContaining({ accessToken: 'subscription' }), expect.objectContaining({ apiKey: 'new-key' })])
	let subscription = await command.run('', { method: 'Claude subscription' }, ctx)
	expect(subscription.askArgs).toBe('claude')
	expect(subscription.ask?.fields[0]?.type).toBe('secret')
})

test('/login with an unknown method says which ones exist', async () => {
	let reply = await command.run('nope', undefined, ctx)
	expect(reply.error).toContain('claude')
	expect(reply.ask).toBeUndefined()
})

test('a chosen login method survives question answers; API key never enters history', async () => {
	let events: Event[] = []
	let conn = host.connect((event) => events.push(event))
	let until = async (check: () => unknown) => {
		for (let i = 0; i < 500 && !check(); i++) await Bun.sleep(2)
		if (!check()) throw Error('timed out')
	}
	conn.send({ type: 'create', cwd: '/tmp', model: 'fake/m' })
	let id = (events.find((e) => e.type === 'snapshot') as any).sessionId
	conn.send({ type: 'submit', sessionId: id, text: '/login' })
	await until(() => events.some((e) => e.type === 'question'))
	let first = events.findLast((e) => e.type === 'question') as any
	expect(first.form.fields[0].type).toBe('choice')
	conn.send({ type: 'answer', sessionId: id, question: first.id, answers: { method: 'OpenRouter API key' } })
	await until(() => events.filter((e) => e.type === 'question').length === 2)
	let second = events.findLast((e) => e.type === 'question') as any
	expect(second.form.fields[0].type).toBe('secret')
	conn.send({ type: 'answer', sessionId: id, question: second.id, answers: { key: 'very-private-key' } })
	await until(() => events.some((e) => e.type === 'output' && e.text.includes('openrouter')))
	expect(disk().openrouter.apiKey).toBe('very-private-key')
	expect(readFileSync(history.file(id), 'utf8')).not.toContain('very-private-key')
})

test('ANTHROPIC_API_KEY alone needs no file; a login in the file comes first and the key next', async () => {
	let e = await error(() => auth.anthropic())
	expect(e.message).toContain('/login claude')
	expect(e.message).toContain('ANTHROPIC_API_KEY')
	process.env.ANTHROPIC_API_KEY = 'env-key'
	expect(await auth.anthropic()).toMatchObject({ type: 'api-key', value: 'env-key' })
	expect(existsSync(file())).toBe(false)
	writeFileSync(file(), ason.stringify({ anthropic: { accessToken: 'file-token', refreshToken: 'r', expires: Date.now() - 1 } }), { mode: 0o600 })
	auth.close()
	tokenReply = () => Response.json({ error: 'invalid_grant' }, { status: 400 })
	// The file's login is broken: the key takes over.
	expect(await auth.anthropic()).toMatchObject({ type: 'api-key', value: 'env-key' })
	writeFileSync(file(), ason.stringify({ anthropic: { accessToken: 'file-token', expires: Date.now() + 3_600_000 } }), { mode: 0o600 })
	auth.close()
	expect(await auth.anthropic()).toMatchObject({ type: 'token', value: 'file-token' })
})

test('a session blocked on login takes /login claude and continues by itself once it succeeds', async () => {
	auth.pollMs = () => 5
	// A provider that needs a working anthropic login, as the real one does.
	turns.stream = (): AsyncIterable<StreamEvent> =>
		(async function* (): AsyncGenerator<StreamEvent> {
			try {
				await auth.anthropic()
			} catch (e: any) {
				yield { type: 'error', message: e.message, failure: e.failure }
				return
			}
			yield { type: 'text', text: 'ok' }
			yield { type: 'done', reason: 'end' }
		})()
	let events: Event[] = []
	let conn = host.connect((e) => events.push(e))
	let until = async (check: () => unknown) => {
		for (let i = 0; i < 1000 && !check(); i++) await Bun.sleep(2)
		if (!check()) throw new Error('timed out')
	}
	conn.send({ type: 'create', cwd: '/tmp', model: 'fake/m' })
	let id = (events.find((e) => e.type === 'snapshot') as any).sessionId
	conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => status.stateOf(id).type === 'blocked')
	expect((status.stateOf(id) as any).reason).toContain('/login claude')

	// A failed login blocks again; the question stays answerable.
	for (let code of ['wrong', 'right']) {
		conn.send({ type: 'submit', sessionId: id, text: '/login claude' })
		await until(() => events.some((e) => e.type === 'question' && !events.some((a) => a.type === 'answer' && (a as any).question === (e as any).id)))
		let q = events.findLast((e) => e.type === 'question') as any
		let state = new URL(/https:\S+/.exec(q.form.text)![0]).searchParams.get('state')
		conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { code: code === 'right' ? `c#${state}` : 'wrong' } })
		await until(() => events.some((e) => e.type === 'answer' && (e as any).question === q.id))
		if (code === 'wrong') await until(() => status.stateOf(id).type === 'blocked' && (status.stateOf(id) as any).reason !== 'question')
	}
	await until(() => events.some((e) => e.type === 'turn-end'))
	expect(events.find((e) => e.type === 'turn-end')).toMatchObject({ status: 'completed' })
	expect(readFileSync(history.file(id), 'utf8')).not.toContain(`c#`)
})

test('bare /login on a session blocked on login asks every step; the turn stays blocked on login throughout', async () => {
	auth.pollMs = () => 5
	turns.stream = (): AsyncIterable<StreamEvent> =>
		(async function* (): AsyncGenerator<StreamEvent> {
			try {
				await auth.anthropic()
			} catch (e: any) {
				yield { type: 'error', message: e.message, failure: e.failure }
				return
			}
			yield { type: 'text', text: 'ok' }
			yield { type: 'done', reason: 'end' }
		})()
	let events: Event[] = []
	let conn = host.connect((e) => events.push(e))
	let until = async (check: () => unknown) => {
		for (let i = 0; i < 1000 && !check(); i++) await Bun.sleep(2)
		if (!check()) throw new Error('timed out')
	}
	let loginBlocked = () => status.stateOf(id).type === 'blocked' && (status.stateOf(id) as any).reason !== 'question'
	conn.send({ type: 'create', cwd: '/tmp', model: 'fake/m' })
	let id = (events.find((e) => e.type === 'snapshot') as any).sessionId
	conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(loginBlocked)
	conn.send({ type: 'submit', sessionId: id, text: '/login' })
	await until(() => events.some((e) => e.type === 'question'))
	expect(loginBlocked()).toBe(true)
	let method = events.findLast((e) => e.type === 'question') as any
	conn.send({ type: 'answer', sessionId: id, question: method.id, answers: { method: 'Claude subscription' } })
	await until(() => events.filter((e) => e.type === 'question').length === 2)
	expect(events.some((e) => e.type === 'output' && (e as any).error)).toBe(false)
	expect(loginBlocked()).toBe(true)
	let code = events.findLast((e) => e.type === 'question') as any
	let state = new URL(/https:\S+/.exec(code.form.text)![0]).searchParams.get('state')
	conn.send({ type: 'answer', sessionId: id, question: code.id, answers: { code: `c#${state}` } })
	await until(() => events.some((e) => e.type === 'turn-end'))
	expect(events.find((e) => e.type === 'turn-end')).toMatchObject({ status: 'completed' })
})
