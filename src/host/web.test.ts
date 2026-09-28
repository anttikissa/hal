import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { colors } from '../common/colors.ts'
import { oklch } from '../common/oklch.ts'
import type { StreamEvent } from '../common/blocks.ts'
import type { Event } from '../common/protocol.ts'
import { blobs } from './blobs.ts'
import { clock } from './clock.ts'
import { diag } from './diag.ts'
import { history } from './history.ts'
import { pages } from './pages.ts'
import { host } from './host.ts'
import { tabs } from './tabs.ts'
import { turns } from './turns.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'

const savedHome = process.env.HAL_HOME
const origPort = web.port
const origStream = turns.stream
const origBudget = pages.budget
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
	pages.budget = origBudget
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

const base = () => `http://127.0.0.1:${web.state.server!.port}`

async function login(code: string, headers: Record<string, string> = {}): Promise<Response> {
	let body = new FormData()
	body.set('code', code)
	return fetch(`${base()}/login`, { method: 'POST', body, headers })
}

async function cookie(): Promise<string> {
	let res = await login(webAuth.issue())
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

async function dial(cookieHeader?: string, query = '', origin = base()) {
	let headers: Record<string, string> = origin ? { origin } : {}
	if (cookieHeader) headers.cookie = cookieHeader
	let ws = new WebSocket(`${base().replace('http', 'ws')}/ws${query}`, { headers } as any)
	sockets.push(ws)
	let events: any[] = []
	ws.onmessage = (m) => events.push(ason.parse(String(m.data)))
	let opened = await new Promise<boolean>((resolve) => {
		ws.onopen = () => resolve(true)
		ws.onerror = () => resolve(false)
	})
	let closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)))
	return { ws, events, opened, closed, send: (c: unknown) => ws.send(ason.stringify(c, 'short')) }
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

test('the installable app serves its manifest, PNG icons and service worker', async () => {
	await server.serve()
	web.start()
	let manifest = await (await fetch(`${base()}/manifest.webmanifest`)).json()
	expect(manifest.display).toBe('standalone')
	expect(manifest.name).toBe('Hal')
	for (let icon of manifest.icons) {
		let response = await fetch(new URL(icon.src, base()))
		expect(response.headers.get('content-type')).toBe('image/png')
		let bytes = new Uint8Array(await response.arrayBuffer())
		expect(bytes.length).toBeGreaterThan(100)
		expect(bytes.slice(0, 4)).toEqual(new Uint8Array([137, 80, 78, 71]))
	}
	let sw = await fetch(`${base()}/sw.js`)
	expect(sw.ok).toBe(true)
	expect(sw.headers.get('cache-control')).toBe('no-store')
	let html = await (await fetch(`${base()}/`)).text()
	expect(html).toContain('rel="manifest"')
	expect(html).toContain('rel="apple-touch-icon"')
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
		expect((await login(webAuth.issue())).ok).toBe(true)
		web.compiler = orig
		expect((await fetch(`${base()}/`)).status).toBe(200)
	} finally {
		web.compiler = orig
	}
})

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
	let file = readFileSync(`${home}/state/web-sessions.ason`, 'utf8')
	expect(file).not.toContain(token)
	expect(Object.keys(ason.parse(file) as object)).toHaveLength(2)
})

test('a link with ?auth= logs in and drops the code from the address', async () => {
	await server.serve()
	web.start()
	let id = sessions.create({ cwd: home }).id
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


test('GET /image/<name> is a page naming where the image lives; /raw/<name> its bytes, from /tmp or once gone from its session blob', async () => {
	await server.serve()
	web.start()
	let id = sessions.create({ cwd: home }).id
	let png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d4948445200000138000000d8', 'hex'), Buffer.from('pixels')])
	blobs.stage('abc123.png', 'image/png', png.toString('base64'))
	let jar = await cookie()
	let get = (path: string, auth = true) => fetch(`${base()}${path}`, { headers: auth ? { cookie: jar } : {} })
	let tmp = `${paths.imageDir()}/abc123.png`

	expect((await get('/image/abc123', false)).status).toBe(401)
	expect((await get('/image/abc123.png', false)).status).toBe(401)
	expect((await get('/raw/abc123.png', false)).status).toBe(401)
	let page = await (await get('/image/abc123.png')).text()
	expect(page).toContain(tmp)
	expect(page).toContain('src="/raw/abc123.png"')
	expect(page).toContain(`<code>${tmp}</code> (312 × 216, 30 B)`)
	expect(page).toContain('href="/raw/abc123.png" download="abc123.png"')
	expect(page).toContain('>Open original</a>')
	expect((await get('/image/abc123')).status).toBe(200)
	let larger = Buffer.concat([png, Buffer.alloc(1_234_567 - png.length)])
	blobs.stage('def456.png', 'image/png', larger.toString('base64'))
	expect(await (await get('/image/def456')).text()).toContain('1.2 MB')
	blobs.stage('abc123.jpg', 'image/jpeg', Buffer.from('ffd8ff', 'hex').toString('base64'))
	expect((await get('/image/abc123')).status).toBe(404)
	expect((await get('/image/abc123.png')).status).toBe(200)
	rmSync(`${paths.imageDir()}/abc123.jpg`)
	let res = await get('/raw/abc123.png')
	expect(res.headers.get('content-type')).toBe('image/png')
	expect(Buffer.from(await res.arrayBuffer())).toEqual(png)

	expect(blobs.resolve(id, ['[image/abc123.png]']).unknown).toEqual([])
	let copy = `${paths.sessionDir(id)}/blobs/abc123.png`
	expect(await (await get('/image/abc123.png')).text()).toContain(copy)
	rmSync(tmp)
	page = await (await get('/image/abc123.png')).text()
	expect(page).toContain(copy)
	expect(page).not.toContain(tmp)
	expect(Buffer.from(await (await get('/raw/abc123.png')).arrayBuffer())).toEqual(png)
	expect((await get(`/blob/${id}/abc123`)).status).toBe(200)
	for (let path of ['/image/abc123.jpg', '/image/zzz999.png', '/image/..%2fabc123.png', '/image/abc123.png/x', '/paste/abc123.png', '/raw/abc123']) {
		expect((await get(path)).status).toBe(404)
	}
})

test('a pasted long text lands at the stated /tmp path; its page names that path and shows the text escaped', async () => {
	await server.serve()
	web.start()
	let id = sessions.create({ cwd: home }).id
	let text = 'line 1 <b>&amp;</b>\nline 2\n'
	let stored = blobs.stage('0005ab.txt', 'text/plain', Buffer.from(text).toString('base64'))
	expect(stored.marker).toBe('[paste/0005ab.txt]')
	let tmp = `${paths.tmpDir()}/paste/0005ab.txt`
	expect(readFileSync(tmp, 'utf8')).toBe(text)
	let jar = await cookie()
	let get = (path: string) => fetch(`${base()}${path}`, { headers: { cookie: jar } })
	let page = await (await get('/paste/0005ab.txt')).text()
	expect(page).toContain(tmp)
	expect(page).toContain('line 1 &#60;b&#62;&#38;amp;&#60;/b&#62;\nline 2')
	expect(await (await get('/raw/0005ab.txt')).text()).toBe(text)
	expect((await get('/image/0005ab.txt')).status).toBe(404)
	// The model gets the text itself; the session keeps its own copy.
	expect(blobs.resolve(id, ['see [paste/0005ab.txt]'])).toEqual({ blocks: [{ type: 'text', text: 'see [paste/0005ab.txt]' }], unknown: [] })
	expect(blobs.expand(id, 'see [paste/0005ab.txt]')).toBe(`see ${text}`)
	expect(await (await get('/paste/0005ab.txt')).text()).toContain(`${paths.sessionDir(id)}/blobs/0005ab.txt`)
})

test('a file address takes a link code; a used or expired one gets the gate, which leads back there', async () => {
	await server.serve()
	web.start()
	let now = Date.now()
	let origNow = clock.now
	clock.now = () => now
	try {
		let png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('pixels')])
		blobs.stage('abc123.png', 'image/png', png.toString('base64'))
		let open = (path: string, cookie?: string) => fetch(`${base()}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} })
		let gate = async (res: Response) => {
			expect(res.status).toBe(401)
			expect(res.headers.get('content-type')).toContain('text/html')
			expect(res.headers.get('cache-control')).toBe('no-store')
			expect(await res.text()).toContain('</html>')
		}
		let code = webAuth.issue()
		let first = await open(`/image/abc123.png?auth=${code}`)
		expect(first.status).toBe(303)
		expect(first.headers.get('location')).toBe('/image/abc123.png')
		let jar = first.headers.get('set-cookie')!.split(';')[0]!
		expect(await (await open('/image/abc123.png', jar)).text()).toContain('/raw/abc123.png')
		// Clicked again in another browser: used, so no cookie, and the
		// address it lands on shows the gate.
		let again = await open(`/image/abc123.png?auth=${code}`)
		expect(again.headers.get('location')).toBe('/image/abc123.png')
		expect(again.headers.get('set-cookie')).toBeNull()
		await gate(await open('/image/abc123.png'))
		let late = webAuth.issue()
		now += 10 * 60_000
		expect((await open(`/image/abc123.png?auth=${late}`)).headers.get('set-cookie')).toBeNull()
		await gate(await open(`/blob/1-abc/abc123`))
		// The API still answers a bare 401.
		expect((await open('/login')).status).toBe(401)
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

test('over ws, open-newest opens the newest session and bad messages are refused', async () => {
	await server.serve()
	web.start()
	sessions.create({ cwd: '/tmp' })
	let newer = sessions.create({ cwd: '/tmp' }).id
	let w = await dial(await cookie())
	w.ws.send('{ not ason')
	w.send({ type: 'open-newest', id: 'x1' })
	await until(() => w.events.some((e) => e.type === 'ack'))
	expect(w.events.map((e) => e.type)).toEqual(['tabs', 'rejected', 'snapshot', 'ack'])
	expect(w.events[2].sessionId).toBe(newer)
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
	await until(() => current.events.length)
	expect(current.events[0].type).toBe('tabs')
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
	await until(() => w.events.length === 4)
	expect(w.events.map((e) => e.type)).toEqual(['tabs', 'rejected', 'rejected', 'snapshot'])

	w.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => pushes.length === 1)
	pushes[0]!({ type: 'text', text: 'hello' }, { type: 'done', reason: 'end' })
	await until(() => w.events.some((e) => e.type === 'turn-end') && local.some((e) => e.type === 'turn-end'))
	let seen = (events: any[]) => events.filter((e) => !['snapshot', 'rejected', 'tabs'].includes(e.type))
	expect(seen(w.events)).toEqual(seen(local))
	expect(seen(w.events).map((e) => e.type)).toEqual(['state', 'turn-start', 'state', 'stream', 'turn-end', 'state'])

	// A closed browser is no longer a host client.
	w.ws.close()
	await until(() => host.state.clients.size === 1)
	conn.close()
})

const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) =>
	existsSync(p),
)

// A headless Chrome page driven over the DevTools protocol.
async function browser() {
	let dir = mkdtempSync(`${tmpdir()}/hal-chrome-`)
	let proc = Bun.spawn([chrome!, '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], {
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

// A browser test of provider streaming starts from an already-used home.
function providerHome(): void {
	let id = '1-ready'
	mkdirSync(paths.sessionDir(id))
	writeFileSync(`${paths.sessionDir(id)}/session.ason`, ason.stringify({ id, cwd: '/tmp', model: 'anthropic/claude-opus-5-5', createdAt: new Date().toISOString() }) + '\n')
}

test.skipIf(!chrome)('in a browser the page logs in, remembers it and streams a reply', async () => {
	providerHome()
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
		await b.waitFor(`!!document.querySelector('input[name=code]')`)
		await b.evaluate(`document.querySelector('input').value = 'wrong'; document.querySelector('form').requestSubmit()`)
		await b.waitFor(`document.querySelector('#notice').textContent === 'wrong or expired code'`)
		await b.evaluate(`document.querySelector('input').value = '${webAuth.issue()}'; document.querySelector('form').requestSubmit()`)
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
		expect(await b.evaluate(`document.querySelector('.user').textContent`)).toMatch(/^\d\d:\d\d Youhi$/)
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
		// Regression for Solid 2 delegated events: rc.9 changed the runtime's
		// event property without a matching compiler change. Both onInput and
		// onClick must reach the app, not just render a usable-looking page.
		await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.value = 'clicked'; t.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
		await b.waitFor(`!document.querySelector('.Composer button:not([aria-label]):last-child').disabled`)
		await b.evaluate(`document.querySelector('.Composer button:not([aria-label]):last-child').click()`)
		await b.waitFor(`document.querySelectorAll('.user').length === 2 && document.querySelector('textarea').value === ''`)
		expect(await b.evaluate(`document.querySelectorAll('.user')[1].textContent`)).toContain('clicked')
		expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe('')
		// Hal's cursor sits inside the card that streams, after its text,
		// and back on its own line once the turn ends.
		let release = () => {}
		let gate = new Promise<void>((r) => (release = r))
		turns.stream = () =>
			(async function* (): AsyncGenerator<StreamEvent> {
				yield { type: 'text', text: 'partial' }
				await gate
				yield { type: 'done', reason: 'end' }
			})()
		await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.value = 'more'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
		await b.waitFor(`[...document.querySelectorAll('.Card.assistant')].at(-1)?.querySelector('.Markdown')?.lastElementChild?.matches('.cursor') && !document.querySelector('.cursor-line')`)
		expect(await b.evaluate(`document.querySelectorAll('.cursor').length`)).toBe(1)
		release()
		await b.waitFor(`!!document.querySelector('.cursor-line') && !document.querySelector('.Card .cursor')`)
		// Model text is markdown (task fn): streamed a character at a time,
		// its card never gets shorter, and HTML or a javascript: link in it
		// stays inert text.
		let reply = '**Plan** <script>window.pwned=1</script> <img src=x onerror="window.pwned=2"> [x](javascript:window.pwned=3)\n\n| Name | What |\n|---|---|\n| parser | turns **text** into blocks |\n| renderer | draws them, with a longer cell that wraps |\n\n```ts\nlet x = 2**3\n```\nEND'
		turns.stream = () =>
			(async function* (): AsyncGenerator<StreamEvent> {
				for (let c of reply) {
					yield { type: 'text', text: c }
					await Bun.sleep(2)
				}
				yield { type: 'done', reason: 'end' }
			})()
		let heights = b.evaluate(`(async () => {
			let n = document.querySelectorAll('.Card.assistant').length, seen = []
			for (let i = 0; i < 2000; i++) {
				let card = document.querySelectorAll('.Card.assistant')[n]
				if (card) seen.push(card.getBoundingClientRect().height)
				if (card && document.querySelector('.cursor-line') && card.innerText.includes('END')) return { seen, card: card.innerHTML, active: card.querySelectorAll('script, img, a[href^="javascript"]').length }
				await new Promise((r) => requestAnimationFrame(r))
			}
			return { seen, card: '' }
		})()`)
		await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.value = 'md'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
		let md = (await heights) as { seen: number[]; card: string; active: number }
		expect(md.seen.length).toBeGreaterThan(10)
		expect(md.seen.every((h, i) => i === 0 || h >= md.seen[i - 1]!)).toBe(true)
		expect(md.card).toContain('<table>')
		expect(md.card).toContain('&lt;script&gt;')
		expect(md.active).toBe(0)
		expect(await b.evaluate(`window.pwned`)).toBeUndefined()
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
		// A tap outside it closes it too (a real click, on the backdrop), and
		// so does its close button.
		let closed = `!document.querySelector('dialog.Picker').open && document.activeElement === document.querySelector('textarea')`
		await key('m', true)
		await b.waitFor(`document.querySelector('dialog.Picker').open`)
		for (let type of ['mousePressed', 'mouseReleased']) await b.call('Input.dispatchMouseEvent', { type, x: 2, y: 2, button: 'left', clickCount: 1 })
		await b.waitFor(closed)
		await key('m', true)
		await b.waitFor(`document.querySelector('dialog.Picker').open`)
		await b.evaluate(`document.querySelector('dialog.Picker .close').click()`)
		await b.waitFor(closed)
		// What is typed is the draft: it survives a reload.
		await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.value = 'half a thought'; t.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
		await b.call('Page.reload', {})
		await b.waitFor(`document.querySelector('textarea')?.value === 'half a thought'`)
		// A key typed with the focus outside any field lands in the box,
		// once (a real key event: keydown, then the text).
		await b.evaluate(`document.activeElement.blur()`)
		await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: '!', text: '!' })
		await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: '!' })
		await b.waitFor(`document.activeElement === document.querySelector('textarea') && document.querySelector('textarea').value.split('!').length === 2`)
		// Files dropped on the page attach at the caret in drop order; a PDF
		// is named and refused, and the page stays where it is (task n5).
		mkdirSync(`${home}/drop`, { recursive: true })
		writeFileSync(`${home}/drop/shot.png`, Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('pixels')]))
		writeFileSync(`${home}/drop/notes.md`, '# dropped\n')
		writeFileSync(`${home}/drop/paper.pdf`, '%PDF-1.4\n')
		await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.focus(); t.setSelectionRange(0, 0) })()`)
		let href = await b.evaluate(`location.href`)
		let data = { items: [], files: ['shot.png', 'notes.md', 'paper.pdf'].map((f) => `${home}/drop/${f}`), dragOperationsMask: 1 }
		for (let type of ['dragEnter', 'dragOver']) await b.call('Input.dispatchDragEvent', { type, x: 100, y: 100, data })
		await b.waitFor(`!!document.querySelector('.entry.dropping')`)
		await b.call('Input.dispatchDragEvent', { type: 'drop', x: 100, y: 100, data })
		await b.waitFor(`/^\\[image\\/[0-9a-z]{6}\\.png\\]\\[paste\\/[0-9a-z]{6}\\.md\\]half/.test(document.querySelector('textarea').value)`)
		expect(await b.evaluate(`document.querySelector('#notice').textContent`)).toContain('paper.pdf')
		expect(await b.evaluate(`!!document.querySelector('.entry.dropping')`)).toBe(false)
		let [image, paste] = [...(await b.evaluate(`document.querySelector('textarea').value`)).matchAll(/\/([0-9a-z]{6}\.(?:png|md))\]/g)].map((m) => m[1]!)
		await until(() => existsSync(`${paths.fileDir(paste!)}/${paste}`) && existsSync(`${paths.fileDir(image!)}/${image}`))
		expect(readFileSync(`${paths.fileDir(paste!)}/${paste}`, 'utf8')).toBe('# dropped\n')
		expect(await b.evaluate(`location.href`)).toBe(href)
	} finally {
		host.cwd = origCwd
		await b.close()
	}
}, 20000)

test.skipIf(!chrome)('a background Bash reply links to its recorded call, without showing a successful exit', async () => {
	let id = tabs.create('/tmp')
	let call = history.append(id, { type: 'assistant', block: { type: 'tool_call', id: 'call-1', name: 'bash', input: { command: 'echo ok', description: 'Run echo', background: true } } })
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: '[exit 0]\nok\n', from: id, label: `bash #${call.n}`, advisory: true }] })
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: '[exit 123]\nerror: cannot access file\n', from: id, label: `bash #${call.n}`, advisory: true }] })
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
		await b.call('Page.navigate', { url: `${base()}/${id}` })
		await b.waitFor(`!!document.querySelector('.Card .who a.call')`)
		expect(await b.evaluate(`document.querySelector('.Card .who a.call').getAttribute('href')`)).toBe(`/${id}#${call.n}`)
		expect(await b.evaluate(`document.querySelector('.Card.user.prompt').textContent`)).not.toContain('[exit 0]')
		expect(await b.evaluate(`(() => {
			let card = [...document.querySelectorAll('.Card.user.prompt')].at(-1), status = card.querySelector('.exit')
			return [status.textContent, getComputedStyle(status).color !== getComputedStyle(card).color,
				card.textContent.includes('error: cannot access file'), card.querySelectorAll('.exit').length]
		})()`)).toEqual(['[exit 123]', true, true, 1])
	} finally {
		await b.close()
	}
}, 20000)

test.skipIf(!chrome)('in a browser earlier history loads above: shown cards stay, open ones stay open', async () => {
	// Turns taller than the window, one per page.
	let id = tabs.create('/tmp')
	for (let t = 0; t < 4; t++) {
		history.append(id, { type: 'user', blocks: [{ type: 'text', text: `prompt ${t}` }] })
		history.append(id, { type: 'assistant', block: { type: 'thinking', text: `thought ${t}` } })
		history.append(id, { type: 'assistant', block: { type: 'text', text: `reply ${t}\n`.repeat(80) } })
		history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	}
	pages.budget = () => 1500
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
		await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
		await b.call('Page.navigate', { url: `${base()}/${id}` })
		await b.waitFor(`document.querySelector('main').innerText.includes('thought 3') && !document.querySelector('main').innerText.includes('prompt 0')`)
		// Open the newest thinking card, then read up to the top until the
		// first prompt has arrived.
		await b.evaluate(`[...document.querySelectorAll('.Card.thinking')].at(-1).click()`)
		await b.waitFor(`[...document.querySelectorAll('.Card.thinking')].at(-1).classList.contains('open')`)
		let loaded = await b.evaluate(`(async () => {
			let main = document.querySelector('main'), cards = [...document.querySelectorAll('.Card')], added = 0
			let open = cards.filter((c) => c.classList.contains('open'))
			let seen = new MutationObserver((ms) => { for (let m of ms) for (let n of m.addedNodes) if (n.nodeType === 1 && (n.matches('.Card') || n.querySelector('.Card'))) added++ })
			seen.observe(main, { childList: true, subtree: true })
			for (let i = 0; i < 200 && !main.innerText.includes('prompt 0'); i++) {
				main.scrollTop = 0
				main.dispatchEvent(new Event('scroll'))
				await new Promise((r) => setTimeout(r, 20))
			}
			seen.disconnect()
			let now = [...document.querySelectorAll('.Card')]
			return {
				kept: cards.every((c) => c.isConnected),
				stillOpen: open.length === 1 && open[0].classList.contains('open'),
				opened: now.filter((c) => c.classList.contains('open')).length,
				grew: now.length - cards.length === added && added > 0,
				first: main.innerText.includes('prompt 0'),
			}
		})()`)
		expect(loaded).toEqual({ kept: true, stillOpen: true, opened: 1, grew: true, first: true })
		// A sent prompt's card stays the same node when the host takes it.
		turns.stream = () =>
			(async function* (): AsyncGenerator<StreamEvent> {
				yield { type: 'text', text: 'ok' }
				yield { type: 'done', reason: 'end' }
			})()
		let swapped = await b.evaluate(`(async () => {
			let t = document.querySelector('textarea'); t.value = 'fresh'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
			let card = document.querySelector('.Card.pending')
			for (let i = 0; i < 250 && (card?.classList.contains('pending') || !document.querySelector('main').innerText.includes('ok')); i++) await new Promise((r) => setTimeout(r, 20))
			let body = (c) => c?.textContent.replace(c.querySelector('.who')?.textContent ?? '', '')
			return { same: !!card && card.isConnected && !card.classList.contains('pending'), text: body(card), count: [...document.querySelectorAll('.Card.user')].filter((c) => body(c) === 'fresh').length }
		})()`)
		expect(swapped).toEqual({ same: true, text: 'fresh', count: 1 })
	} finally {
		await b.close()
	}
}, 20000)

test.skipIf(!chrome)('in a browser a block address loads its page, marks its card and opens the whole output', async () => {
	// The linked tool result sits in the first turn, pages away from the tail.
	let id = tabs.create('/tmp')
	let output = Array.from({ length: 40 }, (_, i) => `row ${i + 1}`).join('\n')
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'prompt 0' }] })
	history.append(id, { type: 'assistant', block: { type: 'tool_call', id: 'c0', name: 'bash', input: { command: 'seq 40' } } })
	let result = history.append(id, { type: 'user', blocks: [{ type: 'tool_result', id: 'c0', output }] })
	history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	for (let t = 1; t < 4; t++) {
		history.append(id, { type: 'user', blocks: [{ type: 'text', text: `prompt ${t}` }] })
		history.append(id, { type: 'assistant', block: { type: 'text', text: `reply ${t}\n`.repeat(80) } })
		history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	}
	pages.budget = () => 1500
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
		await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
		await b.call('Page.navigate', { url: `${base()}/${id}#${result.n}` })
		await b.waitFor(`!!document.querySelector('.Card.target.open')?.innerText.includes('row 40')`)
		let seen = await b.evaluate(`(() => {
			let card = document.querySelector('.Card.target'), box = card.getBoundingClientRect(), main = document.querySelector('main').getBoundingClientRect()
			let link = card.querySelector(':scope > a.link')
			return { targets: document.querySelectorAll('.Card.target').length, visible: box.top < main.bottom && box.bottom > main.top, link: link && new URL(link.href).pathname + new URL(link.href).hash }
		})()`)
		expect(seen).toEqual({ targets: 1, visible: true, link: `/${id}#${result.n! - 1}` })
	} finally {
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
		await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
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

test.skipIf(!chrome)('in a browser a command sent mid-stream moves, pending, to where it ran: same card, no fade again', async () => {
	providerHome()
	let id = tabs.create('/tmp')
	let release = () => {}
	let gate = new Promise<void>((r) => (release = r))
	turns.stream = () =>
		(async function* (): AsyncGenerator<StreamEvent> {
			yield { type: 'text', text: 'streaming now' }
			await gate
			yield { type: 'done', reason: 'end' }
		})()
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
		await b.call('Page.navigate', { url: `${base()}/${id}` })
		// Commands naming /help wait in the page until let go, so the
		// pending card is shown (and done fading in) before it lands.
		await b.evaluate(`(() => {
			let send = WebSocket.prototype.send, held = []
			window.letGo = () => held.splice(0).forEach((f) => f())
			WebSocket.prototype.send = function (data) { String(data).includes('/help') ? held.push(() => send.call(this, data)) : send.call(this, data) }
		})()`)
		let enter = (text: string) => b.evaluate(`(() => { let t = document.querySelector('textarea'); t.value = '${text}'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
		// Enter is refused with a notice until the session is open.
		await b.waitFor(`(() => { let t = document.querySelector('textarea'); if (!t) return false; t.value = 'go'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return !document.querySelector('#notice').textContent })()`)
		await b.waitFor(`document.querySelector('main').innerText.includes('streaming now')`)
		await enter('/help')
		await b.waitFor(`(() => { let c = document.querySelector('.Card.pending'); return c && c.textContent === '/help' && !c.getAnimations().length })()`)
		let moved = await b.evaluate(`(async () => {
			let card = document.querySelector('.Card.pending'), reply = document.querySelector('.Card.assistant')
			let before = !!(reply.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)
			window.letGo()
			for (let i = 0; i < 250 && (card.classList.contains('pending') || !document.querySelector('.Card.output')); i++) await new Promise((r) => setTimeout(r, 10))
			let output = document.querySelector('.Card.output')
			return {
				wasAfter: before,
				same: card.isConnected && !card.classList.contains('pending'),
				nowBefore: !!(card.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING),
				fading: [card, reply].some((c) => c.getAnimations().length > 0),
				// The output is new: it fades in.
				fresh: !!output && output.getAnimations().length > 0,
				copies: [...document.querySelectorAll('.Card.user')].filter((c) => c.textContent === '/help').length,
			}
		})()`)
		expect(moved).toEqual({ wasAfter: true, same: true, nowBefore: true, fading: false, fresh: true, copies: 1 })
		release()
	} finally {
		await b.close()
	}
}, 20000)
