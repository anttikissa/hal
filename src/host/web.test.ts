import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { colors } from '../common/colors.ts'
import { oklch } from '../common/oklch.ts'
import type { StreamEvent } from '../common/blocks.ts'
import type { Event } from '../common/protocol.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { web } from './web.ts'

const savedHome = process.env.HAL_HOME
const origPort = web.port
const origStream = host.stream
let home = ''
let sockets: WebSocket[] = []

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-web-`)
	process.env.HAL_HOME = home
	paths.init()
	web.port = () => 0
})

afterEach(async () => {
	for (let ws of sockets) ws.close()
	sockets = []
	await server.stop()
	host.reset()
	sessions.closeAll()
	web.port = origPort
	host.stream = origStream
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

const base = () => `http://127.0.0.1:${web.state.server!.port}`

async function login(password: string): Promise<Response> {
	let body = new FormData()
	body.set('password', password)
	return fetch(`${base()}/login`, { method: 'POST', body })
}

async function cookie(): Promise<string> {
	let res = await login('hello123')
	expect(res.ok).toBe(true)
	return res.headers.get('set-cookie')!.split(';')[0]!
}

async function until(check: () => unknown): Promise<void> {
	for (let i = 0; i < 500; i++) {
		if (check()) return
		await Bun.sleep(2)
	}
	throw new Error('timed out')
}

async function dial(cookieHeader?: string) {
	let ws = new WebSocket(`${base().replace('http', 'ws')}/ws`, { headers: cookieHeader ? { cookie: cookieHeader } : {} } as any)
	sockets.push(ws)
	let events: any[] = []
	ws.onmessage = (m) => events.push(ason.parse(String(m.data)))
	let opened = await new Promise<boolean>((resolve) => {
		ws.onopen = () => resolve(true)
		ws.onerror = () => resolve(false)
	})
	return { ws, events, opened, send: (c: unknown) => ws.send(ason.stringify(c, 'short')) }
}

test('the host serves the web endpoint and stops it with the host', async () => {
	await server.serve()
	expect((await fetch(`${base()}/`)).status).toBe(200)
	let url = base()
	await server.stop()
	expect(web.state.server).toBeNull()
	await expect(fetch(`${url}/`)).rejects.toThrow()
})

test('the page carries the theme as CSS, following overrides, without its code', async () => {
	await server.serve()
	let saved = colors.fgL
	try {
		let html = await (await fetch(`${base()}/`)).text()
		expect(html).toContain(oklch.toHex(colors.assistant().fg!))
		expect(html).toMatch(new RegExp(`\\.tool-bash\\s*\\{[^}]*${oklch.toHex(colors.toolBash().bg!)}`))
		expect(html).not.toContain('fgL')
		colors.fgL = 0.95
		let after = await (await fetch(`${base()}/`)).text()
		expect(after).toContain(oklch.toHex([0.95, colors.fgC, 55]))
	} finally {
		colors.fgL = saved
	}
})

test('login sets a long-lived HttpOnly cookie; a wrong password gets 401', async () => {
	await server.serve()
	let bad = await login('nope')
	expect(bad.status).toBe(401)
	expect(bad.headers.get('set-cookie')).toBeNull()
	let good = await login('hello123')
	let set = good.headers.get('set-cookie')!
	expect(set).toMatch(/HttpOnly/i)
	expect(Number(/Max-Age=(\d+)/i.exec(set)![1])).toBeGreaterThan(365 * 24 * 3600)
})

test('the password is a config function read at call time', async () => {
	let orig = web.password
	web.password = () => 'other'
	try {
		await server.serve()
		expect((await login('hello123')).status).toBe(401)
		expect((await login('other')).ok).toBe(true)
	} finally {
		web.password = orig
	}
})

test('session and ws need the cookie', async () => {
	await server.serve()
	expect((await fetch(`${base()}/session`)).status).toBe(401)
	expect((await fetch(`${base()}/session`, { headers: { cookie: 'hal=wrong' } })).status).toBe(401)
	expect((await dial()).opened).toBe(false)
	expect((await dial('hal=wrong')).opened).toBe(false)
})

test('session names the newest session', async () => {
	await server.serve()
	let c = await cookie()
	expect((await fetch(`${base()}/session`, { headers: { cookie: c } })).status).toBe(204)
	sessions.create({ cwd: '/tmp' })
	let newer = sessions.create({ cwd: '/tmp' }).id
	expect(await (await fetch(`${base()}/session`, { headers: { cookie: c } })).text()).toBe(newer)
})

test('a submit streams to both a web and an in-memory client', async () => {
	let pushes: ((...e: StreamEvent[]) => void)[] = []
	host.stream = () =>
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
	let local: Event[] = []
	let conn = host.connect((e) => local.push(e))
	conn.send({ type: 'create', cwd: '/tmp', model: 'fake/m' })
	let id = (local[0] as any).sessionId

	let w = await dial(await cookie())
	expect(w.opened).toBe(true)
	// Commands are validated like a socket client's.
	w.ws.send('{ not ason')
	w.send({ type: 'submit', sessionId: id, text: 'hi' })
	w.send({ type: 'open', sessionId: id })
	await until(() => w.events.length === 3)
	expect(w.events.map((e) => e.type)).toEqual(['rejected', 'rejected', 'snapshot'])

	w.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => pushes.length === 1)
	pushes[0]!({ type: 'text', text: 'hello' }, { type: 'done', reason: 'end' })
	await until(() => w.events.some((e) => e.type === 'turn-end') && local.some((e) => e.type === 'turn-end'))
	let seen = (events: any[]) => events.filter((e) => e.type !== 'snapshot' && e.type !== 'rejected')
	expect(seen(w.events)).toEqual(seen(local))
	expect(seen(w.events).map((e) => e.type)).toEqual(['turn-start', 'stream', 'turn-end'])

	// A closed browser is no longer a host client.
	w.ws.close()
	await until(() => host.state.clients.size === 1)
	conn.close()
})

const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) =>
	existsSync(p),
)

// A headless Chrome page driven over the DevTools protocol.
async function browser() {
	let dir = mkdtempSync(`${tmpdir()}/hal-chrome-`)
	let proc = Bun.spawn([chrome!, '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], {
		stdout: 'ignore',
		stderr: 'ignore',
	})
	let port = ''
	await until(() => existsSync(`${dir}/DevToolsActivePort`) && (port = readFileSync(`${dir}/DevToolsActivePort`, 'utf8').split('\n')[0]!))
	let targets: any[] = []
	for (let i = 0; i < 100 && !targets.some((t) => t.type === 'page'); i++) {
		targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
		await Bun.sleep(20)
	}
	let ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
	await new Promise((r) => (ws.onopen = r))
	let next = 0
	let waiting = new Map<number, (m: any) => void>()
	ws.onmessage = (m) => {
		let msg = JSON.parse(String(m.data))
		waiting.get(msg.id)?.(msg)
	}
	let call = (method: string, params: object) =>
		new Promise<any>((resolve) => {
			waiting.set(++next, resolve)
			ws.send(JSON.stringify({ id: next, method, params }))
		})
	let evaluate = async (expression: string) => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
	let waitFor = async (expression: string) => {
		for (let i = 0; i < 250; i++) {
			if (await evaluate(expression)) return
			await Bun.sleep(20)
		}
		throw new Error(`timed out waiting for ${expression}: ${await evaluate("location.href + document.documentElement.outerHTML.slice(-600)")}`)
	}
	let close = async () => {
		ws.close()
		proc.kill()
		await proc.exited
		rmSync(dir, { recursive: true, force: true })
	}
	return { call, evaluate, waitFor, close }
}

test.skipIf(!chrome)('in a browser the page logs in, remembers it and streams a reply', async () => {
	host.stream = () =>
		(async function* (): AsyncGenerator<StreamEvent> {
			yield { type: 'text', text: 'hello from fake' }
			yield { type: 'done', reason: 'end' }
		})()
	let origCwd = web.cwd
	web.cwd = () => '/tmp'
	let b = await browser()
	try {
		await server.serve()
		await b.call('Page.navigate', { url: `${base()}/` })
		await b.waitFor(`!!document.querySelector('input[type=password]')`)
		await b.evaluate(`document.querySelector('input').value = 'wrong'; document.querySelector('form').requestSubmit()`)
		await b.waitFor(`document.querySelector('#notice').textContent === 'wrong password'`)
		await b.evaluate(`document.querySelector('input').value = 'hello123'; document.querySelector('form').requestSubmit()`)
		await b.waitFor(`!!document.querySelector('textarea')`)
		// The page created a session in web.cwd() and opened it.
		await until(() => sessions.newest())
		// Later visits skip the form.
		await b.call('Page.reload', {})
		await b.waitFor(`!!document.querySelector('textarea') && !document.querySelector('form')`)
		// Enter submits once the session is open (until then it is refused
		// with a notice and the text stays).
		await b.waitFor(
			`(() => { let t = document.querySelector('textarea'); t.value = 'hi'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return !document.querySelector('#notice').textContent })()`,
		)
		await b.waitFor(`document.querySelector('main').innerText.includes('hello from fake')`)
		expect(await b.evaluate(`document.querySelector('.user').textContent`)).toBe('hi')
		// The reply wears the theme's assistant colour.
		expect(await b.evaluate(`getComputedStyle(document.querySelector('.assistant')).color`)).toBe(
			`rgb(${oklch.toRgb(colors.assistant().fg!).join(', ')})`,
		)
		expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe('')
	} finally {
		web.cwd = origCwd
		await b.close()
	}
}, 20000)
