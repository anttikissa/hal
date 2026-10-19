// Web logins: codes, cookies, rate limits, expiry, revocation and
// logout.

import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { clock } from './clock.ts'
import { pages } from './pages.ts'
import { host } from './host.ts'
import { tabs } from './tabs.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { webPage } from './web-page.ts'
import { testHome, useWeb, base, login, cookie, until, dial } from './web-fixture.test.ts'

useWeb()

test('a code logs in once with a 10-year HttpOnly SameSite=Strict cookie; a wrong one gets 401', async () => {
	await server.serve()
	web.start()
	let code = webAuth.issue()
	let bad = await login(code === 'zzzzzz' ? 'yyyyyy' : 'zzzzzz')
	expect(bad.status).toBe(401)
	expect(bad.headers.get('set-cookie')).toBeNull()
	// Typed in capitals with look-alikes and spaces still counts.
	let good = await login(` ${code.toUpperCase().replace(/1/g, 'l').replace(/0/g, 'O')} `)
	expect(good.status).toBe(204)
	let set = good.headers.get('set-cookie')!
	expect(set).toMatch(/HttpOnly/i)
	expect(set).toMatch(/SameSite=Strict/i)
	// Plain HTTP on this machine: not Secure, or the browser would drop it.
	expect(set).not.toMatch(/Secure/i)
	expect(Number(/Max-Age=(\d+)/i.exec(set)![1])).toBe(10 * 365 * 24 * 3600)
	let token = /hal=([^;]+)/.exec(set)![1]!
	expect(token).toMatch(/^[0-9a-hjkmnp-tv-z]{20}$/)
	// Used up.
	expect((await login(code)).status).toBe(401)
	// Behind a TLS proxy the cookie is Secure.
	expect((await login(webAuth.issue(), { 'x-forwarded-proto': 'https' })).headers.get('set-cookie')).toMatch(/Secure/i)
	// Only a hash of each token is on disk.
	let file = readFileSync(`${testHome()}/state/web-sessions.ason`, 'utf8')
	expect(file).not.toContain(token)
	expect(Object.keys(ason.parse(file) as object)).toHaveLength(2)
})

test('a link with ?auth= logs in and drops the code from the address', async () => {
	await server.serve()
	web.start()
	let id = sessions.create({ cwd: testHome() }).id
	let res = await fetch(`${base()}/${id}?auth=${webAuth.issue()}&x=1`, { redirect: 'manual' })
	expect(res.status).toBe(303)
	expect(res.headers.get('location')).toBe(`/${id}?x=1`)
	let auth = res.headers.get('set-cookie')!.split(';')[0]!
	expect((await fetch(`${base()}/login`, { headers: { cookie: auth } })).status).toBe(204)
	// A used or made-up code is dropped too, but logs nobody in.
	let stale = await fetch(`${base()}/?auth=abcdef`, { redirect: 'manual' })
	expect(stale.status).toBe(303)
	expect(stale.headers.get('location')).toBe('/')
	expect(stale.headers.get('set-cookie')).toBeNull()
})

test('a code is good for 10 minutes; wrong ones are limited host-wide to 10 a minute', async () => {
	await server.serve()
	web.start()
	let now = Date.now()
	let origNow = clock.now
	clock.now = () => now
	try {
		let late = webAuth.issue()
		now += 10 * 60_000
		expect((await login(late)).status).toBe(401)
		let code = webAuth.issue()
		for (let i = 0; i < 9; i++) expect((await login('000000')).status).toBe(401)
		// Past the limit even a right code is refused unchecked, so it
		// is still good a minute later.
		expect((await login(code)).status).toBe(429)
		now += 61_000
		expect((await login(code)).status).toBe(204)
	} finally {
		clock.now = origNow
	}
})

test('the login check and ws need the cookie', async () => {
	await server.serve()
	web.start()
	expect((await fetch(`${base()}/login`)).status).toBe(401)
	expect((await fetch(`${base()}/login`, { headers: { cookie: 'hal=wrong' } })).status).toBe(401)
	expect((await fetch(`${base()}/login`, { headers: { cookie: await cookie() } })).status).toBe(204)
	expect((await dial()).opened).toBe(false)
	expect((await dial('hal=wrong')).opened).toBe(false)
	// Another site's page can't use the browser's cookie.
	let auth = await cookie()
	expect((await dial(auth, '', 'https://evil.example')).opened).toBe(false)
	expect((await dial(auth, '', '')).opened).toBe(false)
	expect((await dial(auth)).opened).toBe(true)
})

test('an expired or revoked token is refused, and revoking closes open pages', async () => {
	await server.serve()
	web.start()
	let now = Date.now()
	let origNow = clock.now
	clock.now = () => now
	try {
		let old = await cookie()
		const day = 24 * 3600_000
		now += 3649 * day
		let fresh = await cookie()
		let check = async (c: string) => (await fetch(`${base()}/login`, { headers: { cookie: c } })).status
		expect(await check(old)).toBe(204)
		now += 2 * day
		expect(await check(old)).toBe(401)
		expect(await check(fresh)).toBe(204)
		let open = await dial(fresh)
		expect(open.opened).toBe(true)
		let unused = webAuth.issue()
		web.revoke()
		expect(await open.closed).toBe(4001)
		expect(await check(fresh)).toBe(401)
		expect((await dial(fresh)).opened).toBe(false)
		expect((await login(unused)).status).toBe(401)
	} finally {
		clock.now = origNow
	}
})

test('/logout targets every socket of one login, persists refusal, and leaves other logins connected', async () => {
	await server.serve()
	web.start()
	let first = await cookie()
	let id = webAuth.list()[0]!.id
	let second = await cookie()
	let a = await dial(first),
		b = await dial(first),
		other = await dial(second)
	await until(() => [a, b, other].every((w) => w.events.some((e) => e.type === 'tabs')))
	let caller = sessions.create({ cwd: testHome(), model: 'hal/intro' }).id
	let { command } = await import('./commands/logout.ts')
	expect(
		command.run(id, undefined, {
			sessionId: caller,
			cwd: testHome(),
			model: 'hal/intro',
			setCwd() {},
			setModel() {},
			say() {},
		}),
	).toMatchObject({ say: '1 web login(s) revoked; a browser needs a new code' })
	expect(await a.closed).toBe(4001)
	expect(await b.closed).toBe(4001)
	expect(other.ws.readyState).toBe(WebSocket.OPEN)
	webAuth.close()
	expect((await fetch(`${base()}/login`, { headers: { cookie: first } })).status).toBe(401)
	expect((await dial(first)).opened).toBe(false)
	expect((await fetch(`${base()}/login`, { headers: { cookie: second } })).status).toBe(204)
	command.run('all', undefined, {
		sessionId: caller,
		cwd: testHome(),
		model: 'hal/intro',
		setCwd() {},
		setModel() {},
		say() {},
	})
	expect(await other.closed).toBe(4001)
})

test('self logout is same-origin POST only and cannot revoke another login', async () => {
	await server.serve()
	web.start()
	let first = await cookie(),
		second = await cookie()
	let a = await dial(first),
		other = await dial(second)
	expect((await fetch(`${base()}/logout`, { headers: { cookie: first } })).status).toBe(404)
	expect(
		(await fetch(`${base()}/logout`, { method: 'POST', headers: { cookie: first, origin: 'https://example.com' } }))
			.status,
	).toBe(403)
	expect(webAuth.list()).toHaveLength(2)
	let res = await fetch(`${base()}/logout`, {
		method: 'POST',
		headers: { cookie: first, origin: base() },
		redirect: 'manual',
	})
	expect(res.status).toBe(303)
	expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
	expect(await a.closed).toBe(4001)
	expect(other.ws.readyState).toBe(WebSocket.OPEN)
	expect((await fetch(`${base()}/login`, { headers: { cookie: first } })).status).toBe(401)
})

test('revocation while an upgrade awaits the page build refuses the socket', async () => {
	await server.serve()
	web.start()
	let auth = await cookie()
	let original = webPage.version
	let waiting = false
	let release!: (v: string) => void
	webPage.version = () => {
		waiting = true
		return new Promise((r) => {
			release = r
		})
	}
	try {
		let pending = dial(auth, '?v=building&updates=manual')
		await until(() => waiting)
		web.revoke(webAuth.list()[0]!.id)
		release('building')
		expect((await pending).opened).toBe(false)
		expect(web.state.sockets.size).toBe(0)
	} finally {
		webPage.version = original
	}
})
