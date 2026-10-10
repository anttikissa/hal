import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { auth } from './auth.ts'

// Fake credentials only. HAL_HOME and HOME point at temp dirs, so neither
// ./auth.ason nor ~/.hal/auth.ason can be read or written here.

const savedEnv = { HAL_HOME: process.env.HAL_HOME, HOME: process.env.HOME, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
const origTokenUrl = auth.tokenUrl
let home = ''
let server: ReturnType<typeof Bun.serve> | null = null
let requests: any[] = []
let reply: () => Response = () => new Response('{}')

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-auth-`)
	mkdirSync(`${home}/secrets`)
	process.env.HAL_HOME = home
	process.env.HOME = `${home}/user`
	// Real keys never reach a test, even run outside ./test.
	delete process.env.ANTHROPIC_API_KEY
	delete process.env.OPENAI_API_KEY
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

const file = () => `${home}/secrets/auth.ason`
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
	expect((e as any).failure).toBe('auth')

	// A spent refresh token is not tried again...
	refreshed()
	expect((await failure()).message).toContain('invalid_grant')
	expect(requests).toHaveLength(1)
	// ...until the file holds new credentials (the user logged in).
	write({ anthropic: { accessToken: 'secret-access', refreshToken: 'fresh-refresh', expires: earlier() } })
	auth.close()
	expect((await auth.anthropic()).value).toBe('new-access')
})

test('a refresh that fails on the server side or the network is temporary, and tried again', async () => {
	write({ anthropic: { accessToken: 'old', refreshToken: 'r', expires: earlier() } })
	reply = () => new Response('oops', { status: 503 })
	expect((await failure() as any).failure).toBe('temporary')
	refreshed()
	expect((await auth.anthropic()).value).toBe('new-access')
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

const now = () => Date.now()

test('accounts rotate: one limited for the model or with a broken login is skipped', async () => {
	let { limits } = await import('./limits.ts')
	let { paths } = await import('./paths.ts')
	paths.init()
	let told: string[] = []
	let original = auth.broke
	auth.broke = (id, text) => told.push(`${id} ${text}`)
	try {
		write({
			anthropic: [
				{ accessToken: 'a-old', refreshToken: 'a-spent', expires: earlier(), email: 'a@x' },
				{ accessToken: 'b-token', expires: later(), email: 'b@x' },
				{ apiKey: 'c-key' },
			],
		})
		// The two-homes case: another copy already rotated a's refresh token.
		reply = () => Response.json({ error: 'invalid_grant', error_description: 'Refresh token not found or invalid' }, { status: 400 })
		expect(await auth.anthropic('m', { session: 's' })).toMatchObject({ value: 'b-token', account: 'b@x' })
		expect(requests).toHaveLength(1)
		// Skipping a broken login is never silent: the session hears the
		// provider's error, once.
		expect(await auth.anthropic('m', { session: 's' })).toMatchObject({ value: 'b-token' })
		expect(told).toEqual([expect.stringMatching(/^s anthropic login a@x is not working.*invalid_grant \(Refresh token not found or invalid\)/)])
		limits.set(limits.key('anthropic/m', 'b@x'), now() + 3600_000)
		expect(await auth.anthropic('m')).toMatchObject({ value: 'c-key', account: 'account 3' })
		// Another model is not limited on b.
		expect((await auth.anthropic('n')).value).toBe('b-token')
		// Every account limited: when the first comes free.
		limits.set(limits.key('anthropic/m', 'account 3'), now() + 600_000)
		let e: any = await auth.anthropic('m').catch((x) => x)
		expect(e.failure).toBe('limited')
		expect(Math.abs(e.retryAt - (now() + 600_000))).toBeLessThan(1000)
		expect(requests).toHaveLength(1)
	} finally {
		auth.broke = original
		limits.close()
	}
})

test('every login broken is an auth failure naming the problem', async () => {
	write({ anthropic: [{ accessToken: 'x', expires: earlier() }, { accessToken: 'y', refreshToken: 'secret-r', expires: earlier() }] })
	reply = () => Response.json({ error: 'invalid_grant' }, { status: 400 })
	let e: any = await failure()
	expect(e.failure).toBe('auth')
	expect(e.message).toContain('invalid_grant')
	expect(e.message).not.toContain('secret-')
})

test('pickAccount is the per-request override point; a key waits behind any usable subscription', async () => {
	write({ anthropic: [
		{ apiKey: 'key', email: 'key@x' },
		{ accessToken: 'token', email: 'sub@x', expires: later() },
	] })
	let { usage } = await import('./usage.ts')
	let { paths } = await import('./paths.ts')
	paths.init()
	let reset = String(Math.floor(later() / 1000))
	// A key has no usage windows; a busy subscription still comes first.
	usage.observe('anthropic', 'sub@x', new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.95', 'anthropic-ratelimit-unified-5h-reset': reset }))
	expect((await auth.anthropic()).account).toBe('sub@x')
	let original = auth.pickAccount
	auth.pickAccount = (_kind, list) => [list.find((a) => a.name === 'key@x')!, ...list.filter((a) => a.name !== 'key@x')]
	try { expect((await auth.anthropic()).account).toBe('key@x') }
	finally { auth.pickAccount = original; usage.close() }
})

test('a session falls back to a key only while every subscription is out, says so once, and comes back', async () => {
	let { limits } = await import('./limits.ts')
	let { paths } = await import('./paths.ts')
	paths.init()
	let told: string[] = []
	let original = auth.fallback
	auth.fallback = (id, text) => told.push(`${id} ${text}`)
	try {
		write({ openai: [{ accessToken: 'sub', expires: later(), email: 'sub@x' }, { apiKey: 'sk-secret' }] })
		let s = { session: 's' }
		expect((await auth.openai('m', s)).value).toBe('sub')
		limits.set(limits.key('openai/m', 'sub@x'), now() + 60_000)
		expect((await auth.openai('m', s)).value).toBe('sk-secret')
		expect((await auth.openai('m', s)).value).toBe('sk-secret')
		expect(told).toHaveLength(1)
		expect(told[0]).toMatch(/^s using account 2, a paid API key: .*sub@x: rate limited until/)
		expect(told[0]).not.toContain('sk-secret')
		// The subscription is free again: the session leaves the key at once.
		delete limits.store()[limits.key('openai/m', 'sub@x')]
		expect((await auth.openai('m', s)).value).toBe('sub')
	} finally {
		auth.fallback = original
		limits.close()
	}
})

test('a key out of credits is set aside until its entry changes', async () => {
	write({ openai: [{ apiKey: 'k1' }, { apiKey: 'k2' }] })
	expect((await auth.openai()).value).toBe('k1')
	auth.spent('account 1', 'openai')
	expect((await auth.openai()).value).toBe('k2')
	auth.spent('account 2', 'openai')
	let e: any = await auth.openai().catch((x) => x)
	expect(e.failure).toBe('auth')
	expect(e.message).toContain('no credits')
	write({ openai: [{ apiKey: 'k3' }] })
	auth.close()
	expect((await auth.openai()).value).toBe('k3')
})

test('a rejected token is refreshed once; rejected again soon, the login is broken', async () => {
	write({ anthropic: { accessToken: 'bad', refreshToken: 'r', expires: later(), email: 'a@x' } })
	refreshed('new-access', 'r2')
	expect((await auth.anthropic()).value).toBe('bad')
	auth.rejected('a@x')
	expect((await auth.anthropic()).value).toBe('new-access')
	expect(requests).toHaveLength(1)
	auth.rejected('a@x')
	expect(((await failure()) as any).failure).toBe('auth')
	expect(requests).toHaveLength(1)
})

test('changed() resolves when the credentials file appears or changes, not before', async () => {
	let { clock } = await import('./clock.ts')
	let origSleep = clock.sleep
	let polls = 0
	let edit: () => void = () => {}
	clock.sleep = async () => {
		polls++
		if (polls === 3) edit()
	}
	try {
		edit = () => write({ anthropic: { apiKey: 'k' } })
		await auth.changed()
		expect(polls).toBe(3)
		polls = 0
		edit = () => write({ anthropic: { apiKey: 'k2', email: 'someone@example.com' } })
		await auth.changed()
		expect(polls).toBe(3)
		expect((await auth.anthropic()).value).toBe('k2')
		// Aborted: returns without a change.
		let ac = new AbortController()
		ac.abort()
		await auth.changed(ac.signal)
	} finally {
		clock.sleep = origSleep
	}
})

test('rotation takes the least used subscription, skips a limited one, and keeps a session on its account', async () => {
	let { limits } = await import('./limits.ts')
	let { usage } = await import('./usage.ts')
	let { paths } = await import('./paths.ts')
	paths.init()
	let used = (account: string, fraction: number) =>
		usage.observe('anthropic', account, new Headers({ 'anthropic-ratelimit-unified-5h-utilization': String(fraction), 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(later() / 1000)) }))
	try {
		write({
			anthropic: [
				{ apiKey: 'k-key' },
				{ accessToken: 'a-token', expires: later(), email: 'a@x' },
				{ accessToken: 'b-token', expires: later(), email: 'b@x' },
				{ accessToken: 'c-token', expires: later(), email: 'c@x' },
			],
		})
		used('a@x', 0.9)
		used('b@x', 0.3)
		// A key comes after subscriptions whatever its usage.
		used('account 1', 0)
		// c has no data yet: unused.
		expect((await auth.anthropic('m', { session: 's' })).account).toBe('c@x')
		used('c@x', 0.5)
		expect((await auth.anthropic('m', { session: 't' })).account).toBe('b@x')
		// Evenly used, turn after turn: s stays on c (its prompt cache)
		// even when c is the busier one after each turn.
		for (let turn = 0; turn < 4; turn++) {
			expect((await auth.anthropic('m', { session: 's' })).account).toBe('c@x')
			used('c@x', 0.31 + turn * 0.01)
			used('b@x', 0.3 + turn * 0.01)
		}
		// A 429 limits c: s moves to the least used other, and stays there.
		used('a@x', 0.2)
		limits.set(limits.key('anthropic/m', 'c@x'), now() + 3600_000)
		expect((await auth.anthropic('m', { session: 's' })).account).toBe('a@x')
		used('a@x', 0.8)
		expect((await auth.anthropic('m', { session: 's' })).account).toBe('a@x')
		limits.set(limits.key('anthropic/m', 'a@x'), now() + 3600_000)
		limits.set(limits.key('anthropic/m', 'b@x'), now() + 3600_000)
		expect((await auth.anthropic('m', { session: 's' })).value).toBe('k-key')
	} finally {
		limits.close()
		usage.close()
	}
})

test('an account picked with /account goes first until rotation leaves it', async () => {
	let { limits } = await import('./limits.ts')
	let { usage } = await import('./usage.ts')
	let { paths } = await import('./paths.ts')
	paths.init()
	let used = (account: string, fraction: number) =>
		usage.observe('anthropic', account, new Headers({ 'anthropic-ratelimit-unified-5h-utilization': String(fraction), 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(later() / 1000)) }))
	try {
		write({ anthropic: [{ accessToken: 'a-token', expires: later(), email: 'a@x' }, { accessToken: 'b-token', expires: later(), email: 'b@x' }, { apiKey: 'k-key' }] })
		used('a@x', 0.9)
		used('b@x', 0.1)
		expect((await auth.anthropic('m', { session: 's' })).account).toBe('b@x')
		// Picked, a busier account or a key wins over usage ranking.
		auth.choose('anthropic', 's', 'a@x')
		expect((await auth.anthropic('m', { session: 's' })).account).toBe('a@x')
		expect((await auth.anthropic('m', { session: 's' })).account).toBe('a@x')
		auth.choose('anthropic', 's', 'account 3')
		expect((await auth.anthropic('m', { session: 's' })).value).toBe('k-key')
		// Limited, it is left and the pick forgotten.
		auth.choose('anthropic', 's', 'a@x')
		limits.set(limits.key('anthropic/m', 'a@x'), now() + 3600_000)
		expect((await auth.anthropic('m', { session: 's' })).account).toBe('b@x')
		expect(auth.state.picked.has('anthropic s')).toBe(false)
	} finally {
		limits.close()
		usage.close()
	}
})

test('a model counts as limited while every account has spent a window all models share', async () => {
	let { paths } = await import('./paths.ts')
	let { usage } = await import('./usage.ts')
	paths.init()
	let secs = (ms: number) => String(Math.floor(ms / 1000))
	let spent = (resets: number, used = '1') => new Headers({ 'x-codex-primary-used-percent': String(Number(used) * 100), 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': secs(resets) })
	try {
		write({ openai: [{ accessToken: 'a', expires: later(), email: 'a@x' }, { accessToken: 'b', expires: later(), email: 'b@x' }] })
		usage.observe('openai', 'a@x', spent(now() + 3_600_000))
		usage.observe('openai', 'b@x', spent(now() + 7_200_000, '0.9'))
		// One account still has room: any OpenAI model can run.
		expect(auth.limitedUntil('openai/gpt-x')).toBe(0)
		usage.observe('openai', 'b@x', spent(now() + 7_200_000))
		// Every account spent: limited until the first window resets, for every model.
		let until = auth.limitedUntil('openai/gpt-y')
		expect(Math.abs(until - (now() + 3_600_000))).toBeLessThan(2000)
	} finally { usage.close() }
})
