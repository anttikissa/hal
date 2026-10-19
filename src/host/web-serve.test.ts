// The web endpoint serves the page, stops with the host, tells stale
// pages to update and streams to web clients.

import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import type { StreamEvent } from '../common/blocks.ts'
import type { Event } from '../common/protocol.ts'
import { diag } from './diag.ts'
import { host } from './host.ts'
import { turns } from './turns.ts'
import { server } from './server.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { webPage } from './web-page.ts'
import { useWeb, base, login, cookie, until, dial } from './web-fixture.test.ts'

useWeb()

test('the host serves the web endpoint and stops it with the host', async () => {
	await server.serve()
	web.start()
	expect((await fetch(`${base()}/`)).status).toBe(200)
	// A tab's address is the page too; other paths are not.
	expect((await fetch(`${base()}/12-abc`)).status).toBe(200)
	expect((await fetch(`${base()}/12-abc/x`)).status).toBe(404)
	expect((await fetch(`${base()}/session`)).status).toBe(404)
	let url = base()
	await server.stop()
	expect(web.state.server).toBeNull()
	await expect(fetch(`${url}/`)).rejects.toThrow()
})

test('a missing JSX compiler fails the page with 500 and a diag line, not the host', async () => {
	let orig = webPage.compiler
	webPage.compiler = () => Promise.reject(new Error('Cannot find package @solidjs/compiler'))
	try {
		await server.serve()
		web.start()
		let res = await fetch(`${base()}/`)
		expect(res.status).toBe(500)
		expect(readFileSync(diag.file(), 'utf8')).toContain('@solidjs/compiler')
		// The host still answers, and a later request retries the build.
		expect((await login(webAuth.issue())).ok).toBe(true)
		webPage.compiler = orig
		expect((await fetch(`${base()}/`)).status).toBe(200)
	} finally {
		webPage.compiler = orig
	}
})

test('a page built from other code than the host serves is told to reload; its own is served', async () => {
	await server.serve()
	web.start()
	let html = await (await fetch(`${base()}/`)).text()
	let version = /data-version="([^"]+)"/.exec(html)![1]!
	let auth = await cookie()
	let old = await dial(auth, '?v=older')
	expect(await old.closed).toBe(4000)
	expect(old.events).toEqual([])
	let current = await dial(auth, `?v=${version}`)
	await until(() => current.events.some((e) => e.type === 'tabs'))
	expect(current.events.find((e) => e.type === 'tabs')?.type).toBe('tabs')
})

test('manual-update pages stay connected through rebuilds and stale reconnects; auth still revokes them', async () => {
	await server.serve()
	web.start()
	let version = await webPage.version()
	let auth = await cookie()
	let manual = await dial(auth, `?v=${version}&updates=manual`)
	let legacy = await dial(auth, `?v=${version}`)
	let terminal = await dial(auth)
	let stale = await dial(auth, '?v=older&updates=manual')
	await until(() => [manual, legacy, terminal, stale].every((w) => w.events.some((e) => e.type === 'tabs')))
	expect(stale.events[0]).toEqual({ type: 'web-update' })
	let build = webPage.build
	try {
		// Model a half-saved source edit without changing shared source files.
		webPage.build = async () => {
			throw new Error('incomplete build')
		}
		await webPage.refresh()
		expect(await webPage.version()).toBeUndefined()
		expect(manual.events.some((e) => e.type === 'web-update')).toBe(false)
		expect(legacy.ws.readyState).toBe(WebSocket.OPEN)
		webPage.build = async () => ({ html: '', version: 'rebuilt' })
		await webPage.refresh()
		await until(() => manual.events.some((e) => e.type === 'web-update'))
		expect(await legacy.closed).toBe(4000)
		expect(manual.ws.readyState).toBe(WebSocket.OPEN)
		expect(terminal.ws.readyState).toBe(WebSocket.OPEN)
		expect(terminal.events.some((e) => e.type === 'web-update')).toBe(false)
		let reconnect = await dial(auth, `?v=${version}&updates=manual`)
		await until(() => reconnect.events.some((e) => e.type === 'tabs'))
		expect(reconnect.events[0]).toEqual({ type: 'web-update' })
		web.revoke()
		expect(await manual.closed).toBe(4001)
		expect(await reconnect.closed).toBe(4001)
	} finally {
		webPage.build = build
	}
})

test('a submit streams to both a web and an in-memory client', async () => {
	let pushes: ((...e: StreamEvent[]) => void)[] = []
	turns.stream = () =>
		(async function* () {
			let queue: StreamEvent[] = []
			let wake = () => {}
			pushes.push((...e) => {
				queue.push(...e)
				wake()
			})
			while (true) {
				let e = queue.shift()
				if (!e) {
					await new Promise<void>((r) => (wake = r))
					continue
				}
				yield e
				if (e.type === 'done') return
			}
		})()
	await server.serve()
	web.start()
	let local: Event[] = []
	let conn = host.connect((e) => local.push(e))
	conn.send({ type: 'create', cwd: '/tmp', model: 'fake/m' })
	let id = (local.find((e) => e.type === 'snapshot') as any).sessionId

	let w = await dial(await cookie())
	expect(w.opened).toBe(true)
	// Commands are validated like a socket client's.
	w.ws.send('{ not ason')
	w.send({ type: 'submit', sessionId: id, text: 'hi' })
	w.send({ type: 'open', sessionId: id })
	await until(() => w.events.some((e) => e.type === 'snapshot'))
	expect(w.events.map((e) => e.type)).toEqual(['home', 'host-mode', 'tabs', 'rejected', 'rejected', 'snapshot'])

	w.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => pushes.length === 1)
	pushes[0]!({ type: 'text', text: 'hello' }, { type: 'done', reason: 'end' })
	await until(() => w.events.some((e) => e.type === 'turn-end') && local.some((e) => e.type === 'turn-end'))
	let seen = (events: any[]) => events.filter((e) => !['snapshot', 'rejected', 'tabs'].includes(e.type))
	expect(seen(w.events)).toEqual(seen(local))
	expect(seen(w.events).map((e) => e.type)).toEqual([
		'home',
		'host-mode',
		'state',
		'turn-start',
		'state',
		'stream',
		'turn-end',
		'state',
	])

	// A closed browser is no longer a host client.
	w.ws.close()
	await until(() => host.state.clients.size === 1)
	conn.close()
})
