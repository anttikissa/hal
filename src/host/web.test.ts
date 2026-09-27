import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { colors } from '../common/colors.ts'
import { oklch } from '../common/oklch.ts'
import type { StreamEvent } from '../common/blocks.ts'
import type { Event } from '../common/protocol.ts'
import { blobs } from './blobs.ts'
import { diag } from './diag.ts'
import { host } from './host.ts'
import { turns } from './turns.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { web } from './web.ts'

const savedHome = process.env.HAL_HOME
const origPort = web.port
const origStream = turns.stream
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
	turns.stream = origStream
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

test('the page carries the theme as CSS, following overrides, without its code', async () => {
	await server.serve()
	web.start()
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

test('a missing JSX compiler fails the page with 500 and a diag line, not the host', async () => {
	let orig = web.compiler
	web.compiler = () => Promise.reject(new Error('Cannot find package @dom-expressions/compiler'))
	try {
		await server.serve()
		web.start()
		let res = await fetch(`${base()}/`)
		expect(res.status).toBe(500)
		expect(readFileSync(diag.file(), 'utf8')).toContain('@dom-expressions/compiler')
		// The host still answers, and a later request retries the build.
		expect((await login('hello123')).ok).toBe(true)
		web.compiler = orig
		expect((await fetch(`${base()}/`)).status).toBe(200)
	} finally {
		web.compiler = orig
	}
})

test('login sets a long-lived HttpOnly cookie; a wrong password gets 401', async () => {
	await server.serve()
	web.start()
	let bad = await login('nope')
	expect(bad.status).toBe(401)
	expect(bad.headers.get('set-cookie')).toBeNull()
	let good = await login('hello123')
	let set = good.headers.get('set-cookie')!
	expect(set).toMatch(/HttpOnly/i)
	expect(Number(/Max-Age=(\d+)/i.exec(set)![1])).toBeGreaterThan(365 * 24 * 3600)
})

test('GET /blob serves a session’s attachment by exact id, with the cookie only', async () => {
	await server.serve()
	web.start()
	let id = sessions.create({ cwd: home }).id
	let other = sessions.create({ cwd: home }).id
	let png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('pixels')])
	let { blob } = blobs.store(id, 'image/png', png.toString('base64'))
	let jar = await cookie()
	let get = (path: string, auth = true) => fetch(`${base()}${path}`, { headers: auth ? { cookie: jar } : {} })

	let res = await get(`/blob/${id}/${blob}`)
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toBe('image/png')
	expect(Buffer.from(await res.arrayBuffer())).toEqual(png)

	expect((await get(`/blob/${id}/${blob}`, false)).status).toBe(401)
	expect((await get(`/blob/${other}/${blob}`)).status).toBe(404)
	expect((await get(`/blob/${id}/${blob.slice(0, -1)}`)).status).toBe(404)
	expect((await get(`/blob/${id}/${blob}.png`)).status).toBe(404)
	for (let path of [`/blob/${id}/..%2f..%2fconfig.ason`, `/blob/${id}/%2e%2e`, `/blob/${id}/blobs%2f${blob}`, `/blob/..%2f${id}/${blob}`, `/blob/${id}/${blob}/x`]) {
		expect((await get(path)).status).toBe(404)
	}
})

test('the password is a config function read at call time', async () => {
	let orig = web.password
	web.password = () => 'other'
	try {
		await server.serve()
		web.start()
		expect((await login('hello123')).status).toBe(401)
		expect((await login('other')).ok).toBe(true)
	} finally {
		web.password = orig
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
})

test('over ws, open-newest opens the newest session and bad messages are refused', async () => {
	await server.serve()
	web.start()
	sessions.create({ cwd: '/tmp' })
	let newer = sessions.create({ cwd: '/tmp' }).id
	let w = await dial(await cookie())
	w.ws.send('{ not ason')
	w.send({ type: 'open-newest', id: 'x1' })
	await until(() => w.events.some((e) => e.type === 'ack'))
	expect(w.events.map((e) => e.type)).toEqual(['rejected', 'snapshot', 'ack'])
	expect(w.events[1].sessionId).toBe(newer)
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
	expect(seen(w.events).map((e) => e.type)).toEqual(['state', 'turn-start', 'state', 'stream', 'turn-end', 'state'])

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
	turns.stream = () =>
		(async function* (): AsyncGenerator<StreamEvent> {
			yield { type: 'text', text: 'hello from fake' }
			yield { type: 'done', reason: 'end' }
		})()
	let origCwd = host.cwd
	host.cwd = () => '/tmp'
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Page.navigate', { url: `${base()}/` })
		await b.waitFor(`!!document.querySelector('input[type=password]')`)
		await b.evaluate(`document.querySelector('input').value = 'wrong'; document.querySelector('form').requestSubmit()`)
		await b.waitFor(`document.querySelector('#notice').textContent === 'wrong password'`)
		await b.evaluate(`document.querySelector('input').value = 'hello123'; document.querySelector('form').requestSubmit()`)
		await b.waitFor(`!!document.querySelector('textarea')`)
		// The page created a session in host.cwd() and opened it.
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
		// Typing redraws the message box, not the transcript: the cards keep
		// their DOM, so none replays its fade-in.
		let typed = await b.evaluate(`(async () => {
			let cards = [...document.querySelectorAll('.Card')], added = 0
			let seen = new MutationObserver((ms) => { for (let m of ms) for (let n of m.addedNodes) if (n.nodeType === 1 && (n.matches('.Card') || n.querySelector('.Card'))) added++ })
			seen.observe(document.querySelector('main'), { childList: true, subtree: true })
			let t = document.querySelector('textarea')
			for (let c of 'abc') { t.value += c; t.dispatchEvent(new InputEvent('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 10)) }
			seen.disconnect()
			t.value = ''; t.dispatchEvent(new InputEvent('input', { bubbles: true }))
			return { cards: cards.length, kept: cards.every((c) => c.isConnected), added }
		})()`)
		expect(typed).toEqual({ cards: 2, kept: true, added: 0 })
		let key = (k: string, ctrl = false) => b.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', ctrlKey: ${ctrl}, bubbles: true }))`)
		// A question is a form the keys fill in: Right picks "no", Enter
		// answers, and the question shows its answer.
		await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.value = '/cd ${home}/nope'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
		await b.waitFor(`document.activeElement?.getAttribute('aria-pressed') === 'true'`)
		expect(await b.evaluate(`document.querySelector('textarea').disabled`)).toBe(true)
		await key('ArrowRight')
		await b.waitFor(`document.querySelector('[aria-pressed=true]')?.textContent === 'no'`)
		await key('Enter')
		await b.waitFor(`!document.querySelector('form') && document.querySelector('main').innerText.includes('Create it?\\n  no')`)
		await b.waitFor(`document.activeElement === document.querySelector('textarea')`)
		// Ctrl-M opens the model picker, which takes the keys; Escape
		// closes it and gives the message box the focus back.
		await key('m', true)
		await b.waitFor(`document.querySelector('dialog.Picker').open && document.querySelectorAll('dialog.Picker li').length > 0`)
		await key('Escape')
		await b.waitFor(`!document.querySelector('dialog.Picker').open && document.activeElement === document.querySelector('textarea')`)
		// What is typed is the draft: it survives a reload.
		await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.value = 'half a thought'; t.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
		await b.call('Page.reload', {})
		await b.waitFor(`document.querySelector('textarea')?.value === 'half a thought'`)
	} finally {
		host.cwd = origCwd
		await b.close()
	}
}, 20000)

test.skipIf(!chrome)('in a browser tabs are links; new, Back and close move the address; phones get a sheet', async () => {
	let origCwd = host.cwd
	host.cwd = () => '/tmp'
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Network.setCookie', { name: 'hal', value: 'hello123', url: base() })
		await b.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
		await b.call('Page.navigate', { url: `${base()}/` })
		// Landing on the first (new) tab rewrites the address.
		await b.waitFor(`document.querySelectorAll('.Tabs .strip a').length === 1 && /\\/\\d+-[a-z]{3}$/.test(location.pathname)`)
		let first = await b.evaluate(`location.pathname`)
		expect(await b.evaluate(`document.querySelector('.Tabs .strip a').getAttribute('href')`)).toBe(first)
		await b.evaluate(`document.querySelector('.Tabs .strip .new').click()`)
		await b.waitFor(`document.querySelectorAll('.Tabs .strip a').length === 2 && location.pathname !== '${first}'`)
		let second = await b.evaluate(`location.pathname`)
		expect(await b.evaluate(`document.querySelector('.Tabs .strip [aria-current]').getAttribute('href')`)).toBe(second)
		// The strip never scrolls sideways.
		expect(await b.evaluate(`(() => { let s = document.querySelector('.Tabs .strip'); return s.scrollWidth <= s.clientWidth })()`)).toBe(true)
		// Back shows the first tab again; a click on a tab link pushes.
		await b.evaluate(`history.back()`)
		await b.waitFor(`location.pathname === '${first}' && document.querySelector('.Tabs .strip [aria-current]')?.getAttribute('href') === '${first}'`)
		await b.evaluate(`document.querySelector('.Tabs .strip a[href="${second}"]').click()`)
		await b.waitFor(`location.pathname === '${second}'`)
		// Closing the shown tab lands on its neighbour, replacing the entry.
		let entries = await b.evaluate(`history.length`)
		await b.evaluate(`document.querySelector('.Tabs .strip .item:has([aria-current]) .close').click()`)
		await b.waitFor(`document.querySelectorAll('.Tabs .strip a').length === 1 && location.pathname === '${first}'`)
		expect(await b.evaluate(`history.length`)).toBe(entries)
		// A phone: one button opening a sheet with the same tabs.
		await b.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true })
		await b.waitFor(`getComputedStyle(document.querySelector('.Tabs .strip')).display === 'none'`)
		await b.evaluate(`document.querySelector('.Tabs .menu').click()`)
		await b.waitFor(`document.querySelector('.Tabs .sheet').open && document.querySelectorAll('.Tabs .sheet a').length === 1`)
		await b.evaluate(`document.querySelector('.Tabs .sheet .new').click()`)
		await b.waitFor(`!document.querySelector('.Tabs .sheet').open && location.pathname !== '${first}'`)
		expect(await b.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
	} finally {
		host.cwd = origCwd
		await b.close()
	}
}, 20000)
