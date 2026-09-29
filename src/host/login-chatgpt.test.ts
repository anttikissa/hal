// /login chatgpt and OpenAI token refresh. Fake device, token endpoints
// and JWTs, a temp HAL_HOME; never the real credentials file.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { auth } from './auth.ts'
import { clock } from './clock.ts'
import { command } from './commands/login.ts'
import { chatgptLogin } from './login-chatgpt.ts'

const saved = { HAL_HOME: process.env.HAL_HOME, HOME: process.env.HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
const orig = { tokenUrl: auth.tokenUrl, deviceUrl: chatgptLogin.deviceUrl, timeoutMs: chatgptLogin.timeoutMs }
let home = ''
let server: ReturnType<typeof Bun.serve>
let seen: { path: string; body: any; type: string | null }[] = []
// How many polls answer "not yet" before the code is entered.
let pending = 0
let tokenStatus = 200
let deviceStatus = 200

const jwt = (claims: object) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`
const access = (accountId = 'acct-1', email = 'me@example.com') =>
	jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId }, 'https://api.openai.com/profile': { email } })
let issued = access()

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-chatgpt-`)
	process.env.HAL_HOME = home
	process.env.HOME = `${home}/user`
	delete process.env.OPENAI_API_KEY
	seen = []
	pending = 0
	tokenStatus = 200
	deviceStatus = 200
	issued = access()
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			let path = new URL(req.url).pathname
			let type = req.headers.get('content-type')
			let text = await req.text()
			let body = type?.includes('json') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text))
			seen.push({ path, body, type })
			if (path === '/device/usercode') return deviceStatus === 200 ? Response.json({ device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: 0 }) : new Response('', { status: deviceStatus })
			if (path === '/device/token') {
				if (pending-- > 0) return new Response('', { status: 403 })
				return Response.json({ authorization_code: 'auth-code', code_challenge: 'c', code_verifier: 'verifier' })
			}
			if (tokenStatus !== 200) return Response.json({ error: 'invalid_grant', error_description: 'secret-code bad' }, { status: tokenStatus })
			return Response.json({ access_token: issued, refresh_token: 'refresh-1', expires_in: 3600 })
		},
	})
	auth.tokenUrl = () => `http://127.0.0.1:${server.port}/token`
	chatgptLogin.deviceUrl = () => `http://127.0.0.1:${server.port}/device`
})

afterEach(() => {
	auth.close()
	server.stop(true)
	Object.assign(auth, { tokenUrl: orig.tokenUrl })
	Object.assign(chatgptLogin, { deviceUrl: orig.deviceUrl, timeoutMs: orig.timeoutMs })
	for (let [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k]
		else process.env[k] = v
	}
	rmSync(home, { recursive: true, force: true })
})

const file = () => `${home}/auth.ason`
const disk = () => ason.parse(readFileSync(file(), 'utf8')) as any
function context() {
	let said: string[] = []
	return { said, ctx: { sessionId: 's', cwd: '/tmp', model: 'openai/gpt-5.5', setCwd() {}, setModel() {}, say: (t: string) => said.push(t) } }
}

test('/login offers the device sign-in setting before selecting ChatGPT; direct login shows it before contacting OpenAI', async () => {
	let menu = await command.run('', undefined, context().ctx)
	expect(menu.ask?.text).toContain('Enable device code sign-in at https://chatgpt.com/#settings/Security')
	let atFirstMessage = -1
	await chatgptLogin.run(() => { if (atFirstMessage < 0) atFirstMessage = seen.length })
	expect(atFirstMessage).toBe(0)
})

test('/login chatgpt shows the URL and code first, waits for the code, then saves a working openai login', async () => {
	pending = 2
	let { said, ctx } = context()
	let reply = await command.run('chatgpt', undefined, ctx)
	expect(said).toHaveLength(2)
	expect(said[0]).toContain('Enable device code sign-in at https://chatgpt.com/#settings/Security')
	expect(said[1]).toContain('https://auth.openai.com/codex/device')
	expect(said[1]).toContain('ABCD-1234')
	expect(reply.say).toContain('me@example.com')
	expect(seen.filter((r) => r.path === '/device/token')).toHaveLength(3)
	let exchange = seen.find((r) => r.path === '/token')!
	expect(exchange.type).toContain('x-www-form-urlencoded')
	expect(exchange.body).toMatchObject({ grant_type: 'authorization_code', code: 'auth-code', code_verifier: 'verifier' })
	expect(statSync(file()).mode & 0o777).toBe(0o600)
	expect(disk().openai).toMatchObject({ accessToken: issued, refreshToken: 'refresh-1', accountId: 'acct-1', email: 'me@example.com' })
	expect(await auth.openai()).toMatchObject({ type: 'token', value: issued, account: 'me@example.com', accountId: 'acct-1' })
})

test('the openai alias works, and logins are kept per ChatGPT account beside anthropic ones', async () => {
	writeFileSync(file(), ason.stringify({ anthropic: { apiKey: 'k' }, openai: { accessToken: 'old', refreshToken: 'r', accountId: 'acct-1', plan: 'plus' } }), { mode: 0o600 })
	await command.run('openai', undefined, context().ctx)
	expect(disk().openai).toMatchObject({ accessToken: issued, accountId: 'acct-1', plan: 'plus' })
	issued = access('acct-2', 'other@example.com')
	await command.run('chatgpt', undefined, context().ctx)
	expect(disk().openai.map((e: any) => e.accountId)).toEqual(['acct-1', 'acct-2'])
	expect(disk().anthropic).toEqual({ apiKey: 'k' })
})

test('a login that is never finished times out, and failures never echo codes or tokens', async () => {
	pending = Infinity
	chatgptLogin.timeoutMs = () => 30
	await expect(command.run('chatgpt', undefined, context().ctx) as Promise<unknown>).rejects.toThrow('timed out')
	pending = 0
	tokenStatus = 400
	let e: any = await (command.run('chatgpt', undefined, context().ctx) as Promise<unknown>).catch((x: any) => x)
	expect(e.message).toContain('invalid_grant')
	expect(e.message).not.toContain('secret-code')
	expect(e.message).not.toContain('auth-code')
	expect(existsSync(file())).toBe(false)
	deviceStatus = 404
	let failed = context()
	await expect(command.run('chatgpt', undefined, failed.ctx) as Promise<unknown>).rejects.toThrow('https://chatgpt.com/#settings/Security')
	expect(failed.said[0]).toContain('Enable device code sign-in')
})

test('an ended /login chatgpt, good or not, wakes sessions blocked on login', async () => {
	let before = auth.state.logins
	deviceStatus = 500
	await (command.run('chatgpt', undefined, context().ctx) as Promise<unknown>).catch(() => {})
	expect(auth.state.logins).toBe(before + 1)
})

test('an expired openai token refreshes with the Codex request and keeps the rotated tokens', async () => {
	writeFileSync(file(), ason.stringify({ openai: { accessToken: 'stale', refreshToken: 'r0', expires: clock.now() - 1, email: 'me@example.com' } }), { mode: 0o600 })
	issued = access('acct-9')
	let cred = await auth.openai('gpt-5.5')
	expect(cred).toMatchObject({ type: 'token', value: issued })
	expect(seen).toEqual([expect.objectContaining({ path: '/token', body: expect.objectContaining({ grant_type: 'refresh_token', refresh_token: 'r0', client_id: expect.any(String) }) })])
	expect(disk().openai).toMatchObject({ accessToken: issued, refreshToken: 'refresh-1', accountId: 'acct-9' })
})

test('OPENAI_API_KEY alone needs no file; no login at all names both ways', async () => {
	let e = await auth.openai().catch((x: any) => x)
	expect(e.message).toContain('/login chatgpt')
	expect(e.message).toContain('OPENAI_API_KEY')
	expect(e.failure).toBe('auth')
	process.env.OPENAI_API_KEY = 'sk-env'
	expect(await auth.openai()).toMatchObject({ type: 'api-key', value: 'sk-env', account: 'OPENAI_API_KEY' })
	// An anthropic login is no openai login.
	await expect(auth.anthropic()).rejects.toThrow('/login claude')
})
