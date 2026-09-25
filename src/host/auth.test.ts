import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { auth } from './auth.ts'

// Fake credentials only. HAL_HOME and HOME point at temp dirs, so neither
// ./auth.ason nor ~/.hal/auth.ason can be read or written here.

const savedEnv = { HAL_HOME: process.env.HAL_HOME, HOME: process.env.HOME }
const origTokenUrl = auth.tokenUrl
let home = ''
let server: ReturnType<typeof Bun.serve> | null = null
let requests: any[] = []
let reply: () => Response = () => new Response('{}')

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-auth-`)
	process.env.HAL_HOME = home
	process.env.HOME = `${home}/user`
	requests = []
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			requests.push(await req.json())
			// Let concurrent callers pile up before answering.
			await Bun.sleep(20)
			return reply()
		},
	})
	auth.tokenUrl = () => `http://127.0.0.1:${server!.port}/v1/oauth/token`
})

afterEach(() => {
	auth.close()
	server?.stop(true)
	auth.tokenUrl = origTokenUrl
	for (let [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k]
		else process.env[k] = v
	}
	rmSync(home, { recursive: true, force: true })
})

const file = () => `${home}/auth.ason`
const write = (data: unknown) => writeFileSync(file(), ason.stringify(data) + '\n', { mode: 0o600 })
const disk = () => ason.parse(readFileSync(file(), 'utf8')) as any
const later = () => Date.now() + 3_600_000
const earlier = () => Date.now() - 1_000

function refreshed(access = 'new-access', refresh = 'new-refresh', expiresIn = 7200) {
	reply = () => Response.json({ access_token: access, refresh_token: refresh, expires_in: expiresIn })
}

async function failure(): Promise<Error> {
	try {
		await auth.anthropic()
	} catch (e) {
		return e as Error
	}
	throw new Error('expected auth.anthropic() to fail')
}

test('single-entry shape: a valid token is returned without refreshing or rewriting', async () => {
	write({ anthropic: { accessToken: 'fake-access', refreshToken: 'fake-refresh', expires: later(), email: 'a@example.com' } })
	let before = readFileSync(file(), 'utf8')
	let cred = await auth.anthropic()
	expect(cred).toMatchObject({ type: 'token', value: 'fake-access', email: 'a@example.com' })
	await Bun.sleep(0)
	expect(requests).toHaveLength(0)
	expect(readFileSync(file(), 'utf8')).toBe(before)
})

test('array shape: first entry holding a credential is used', async () => {
	write({ anthropic: [{ email: 'metadata-only' }, { accessToken: 'second', expires: later() }, { accessToken: 'third' }] })
	expect((await auth.anthropic()).value).toBe('second')
})

test('an apiKey entry is returned as an api key', async () => {
	write({ anthropic: { apiKey: 'fake-key' } })
	expect(await auth.anthropic()).toMatchObject({ type: 'api-key', value: 'fake-key' })
})

test('expired token is refreshed and only this copy is rewritten, 0600, others kept', async () => {
	let userAuth = `${home}/user/.hal/auth.ason`
	mkdirSync(`${home}/user/.hal`, { recursive: true })
	writeFileSync(userAuth, 'untouched')
	write({
		anthropic: [{ accessToken: 'old-access', refreshToken: 'old-refresh', expires: earlier(), email: 'a@example.com' }, { accessToken: 'other' }],
		openai: { accessToken: 'openai-token' },
	})
	refreshed()
	let start = Date.now()
	let cred = await auth.anthropic()
	expect(cred.value).toBe('new-access')
	expect(requests).toHaveLength(1)
	expect(requests[0]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'old-refresh' })
	expect(typeof requests[0].client_id).toBe('string')

	let saved = disk()
	expect(saved.anthropic[0]).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh', email: 'a@example.com' })
	expect(saved.anthropic[0].expires).toBeGreaterThanOrEqual(start + 7200_000)
	expect(saved.anthropic[1]).toEqual({ accessToken: 'other' })
	expect(saved.openai).toEqual({ accessToken: 'openai-token' })
	expect(statSync(file()).mode & 0o777).toBe(0o600)
	expect(readFileSync(userAuth, 'utf8')).toBe('untouched')

	// Now fresh: no second refresh.
	expect((await auth.anthropic()).value).toBe('new-access')
	expect(requests).toHaveLength(1)
})

test('a token about to expire is refreshed early', async () => {
	write({ anthropic: { accessToken: 'old', refreshToken: 'r', expires: Date.now() + 5_000 } })
	refreshed()
	expect((await auth.anthropic()).value).toBe('new-access')
})

test('refresh response without a new refresh token keeps the old one', async () => {
	write({ anthropic: { accessToken: 'old', refreshToken: 'keep-me', expires: earlier() } })
	reply = () => Response.json({ access_token: 'new-access', expires_in: 60 })
	await auth.anthropic()
	expect(disk().anthropic.refreshToken).toBe('keep-me')
})

test('concurrent callers share one refresh', async () => {
	write({ anthropic: { accessToken: 'old', refreshToken: 'r', expires: earlier() } })
	refreshed()
	let creds = await Promise.all([auth.anthropic(), auth.anthropic(), auth.anthropic()])
	expect(creds.map((c) => c.value)).toEqual(['new-access', 'new-access', 'new-access'])
	expect(requests).toHaveLength(1)
})

test('failed refresh is a clear error without secrets, and the file is unchanged', async () => {
	write({ anthropic: { accessToken: 'secret-access', refreshToken: 'secret-refresh', expires: earlier() } })
	let before = readFileSync(file(), 'utf8')
	reply = () => Response.json({ error: 'invalid_grant', error_description: 'bad secret-refresh' }, { status: 400 })
	let e = await failure()
	expect(e.message).toContain('refresh failed')
	expect(e.message).toContain('400')
	expect(e.message).not.toContain('secret-')
	expect(readFileSync(file(), 'utf8')).toBe(before)

	// Not wedged: a later call retries.
	refreshed()
	expect((await auth.anthropic()).value).toBe('new-access')
})

test('refresh response without an access token is an error', async () => {
	write({ anthropic: { accessToken: 'old', refreshToken: 'r', expires: earlier() } })
	reply = () => Response.json({ nope: true })
	expect((await failure()).message).toContain('access token')
})

test('expired token without a refresh token is an error', async () => {
	write({ anthropic: { accessToken: 'old', expires: earlier() } })
	expect((await failure()).message).toContain('expired')
	expect(requests).toHaveLength(0)
})

test('missing file is a clear error naming it, and is not created', async () => {
	let e = await failure()
	expect(e.message).toContain('auth.ason')
	expect(existsSync(file())).toBe(false)
})

test('malformed file is an error that does not echo its content', async () => {
	writeFileSync(file(), "{ anthropic: { accessToken: 'secret-access', ")
	let e = await failure()
	expect(e.message).toContain('auth.ason')
	expect(e.message).not.toContain('secret-access')
})

test('missing or unusable anthropic entries are errors without secrets', async () => {
	for (let data of [
		{ openai: { accessToken: 'secret-openai' } },
		{ anthropic: 'secret-string' },
		{ anthropic: [] },
		{ anthropic: { email: 'x@example.com', refreshToken: 'secret-refresh' } },
		{ anthropic: [42, 'secret-item'] },
		{ anthropic: { accessToken: 'secret-access', expires: 'soon' } },
	]) {
		auth.close()
		write(data)
		let e = await failure()
		expect(e.message).toContain('anthropic')
		expect(e.message).not.toContain('secret-')
	}
})

test('the file is read from the current home at call time', async () => {
	write({ anthropic: { accessToken: 'first' } })
	expect((await auth.anthropic()).value).toBe('first')
	let other = mkdtempSync(`${tmpdir()}/hal-auth-other-`)
	try {
		process.env.HAL_HOME = other
		writeFileSync(`${other}/auth.ason`, ason.stringify({ anthropic: { accessToken: 'second' } }))
		expect((await auth.anthropic()).value).toBe('second')
	} finally {
		auth.close()
		rmSync(other, { recursive: true, force: true })
	}
})
