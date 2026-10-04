import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
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
import { status } from './status.ts'
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



test('a missing JSX compiler fails the page with 500 and a diag line, not the host', async () => {
	let orig = web.compiler
	web.compiler = () => Promise.reject(new Error('Cannot find package @solidjs/compiler'))
	try {
		await server.serve()
		web.start()
		let res = await fetch(`${base()}/`)
		expect(res.status).toBe(500)
		expect(readFileSync(diag.file(), 'utf8')).toContain('@solidjs/compiler')
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

test('binary file page previews no bytes and raw download is safe', async () => {
	await server.serve()
	web.start()
	let file = blobs.stage('a1b2c3.pdf', 'application/octet-stream', Buffer.from([0, 255, 60, 88]).toString('base64'))
	expect(file.marker).toBe('[file/a1b2c3.pdf]')
	let jar = await cookie()
	let get = (path: string) => fetch(`${base()}${path}`, { headers: { cookie: jar } })
	let page = await (await get('/file/a1b2c3.pdf')).text()
	expect(page).toContain(`${paths.tmpDir()}/file/a1b2c3.pdf`)
	expect(page).toContain('Binary file')
	expect(page).not.toContain('&#60;X')
	let raw = await get('/raw/a1b2c3.pdf')
	expect(raw.headers.get('content-disposition')).toContain('attachment')
	expect(raw.headers.get('x-content-type-options')).toBe('nosniff')
	expect(new Uint8Array(await raw.arrayBuffer())).toEqual(new Uint8Array([0, 255, 60, 88]))
	expect((await get('/image/a1b2c3.pdf')).status).toBe(404)
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

test('manual-update pages stay connected through rebuilds and stale reconnects; auth still revokes them', async () => {
	await server.serve()
	web.start()
	let version = await web.version()
	let auth = await cookie()
	let manual = await dial(auth, `?v=${version}&updates=manual`)
	let legacy = await dial(auth, `?v=${version}`)
	let terminal = await dial(auth)
	let stale = await dial(auth, '?v=older&updates=manual')
	await until(() => [manual, legacy, terminal, stale].every((w) => w.events.some((e) => e.type === 'tabs')))
	expect(stale.events[0]).toEqual({ type: 'web-update' })
	let build = web.build
	try {
		// Model a half-saved source edit without changing shared source files.
		web.build = async () => { throw new Error('incomplete build') }
		await web.refresh()
		expect(await web.version()).toBeUndefined()
		expect(manual.events.some((e) => e.type === 'web-update')).toBe(false)
		expect(legacy.ws.readyState).toBe(WebSocket.OPEN)
		web.build = async () => ({ html: '', version: 'rebuilt' })
		await web.refresh()
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
		web.build = build
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
	await until(() => w.events.length === 4)
	expect(w.events.map((e) => e.type)).toEqual(['tabs', 'rejected', 'rejected', 'snapshot'])

	w.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => pushes.length === 1)
	pushes[0]!({ type: 'text', text: 'hello' }, { type: 'done', reason: 'end' })
	await until(() => w.events.some((e) => e.type === 'turn-end') && local.some((e) => e.type === 'turn-end'))
	let seen = (events: any[]) => events.filter((e) => !['snapshot', 'rejected', 'tabs'].includes(e.type))
	expect(seen(w.events)).toEqual(seen(local))
	expect(seen(w.events).map((e) => e.type)).toEqual(['state', 'meta', 'turn-start', 'state', 'stream', 'turn-end', 'state'])

	// A closed browser is no longer a host client.
	w.ws.close()
	await until(() => host.state.clients.size === 1)
	conn.close()
})

const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) =>
	existsSync(p),
)

// A headless Chrome page driven over the DevTools protocol.
async function launch() {
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
	// Solid dev diagnostics ("[STRICT_READ_UNTRACKED] …") the page logged.
	let diagnostics: string[] = []
	ws.onmessage = (m) => {
		let msg = JSON.parse(String(m.data))
		waiting.get(msg.id)?.(msg)
		if (msg.method !== 'Runtime.consoleAPICalled') return
		let text = msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ')
		if (/^\[[A-Z][A-Z_]+\]/.test(text)) diagnostics.push(text)
	}
	let call = (method: string, params: object) =>
		new Promise<any>((resolve) => {
			waiting.set(++next, resolve)
			ws.send(JSON.stringify({ id: next, method, params }))
		})
	let evaluate = async (expression: string) => {
		let response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
		if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text)
		return response.result?.result?.value
	}
	let waitFor = async (expression: string) => {
		for (let i = 0; i < 250; i++) {
			if (await evaluate(expression)) return
			await Bun.sleep(20)
		}
		throw new Error(`timed out waiting for ${expression}: ${await evaluate("location.href + document.documentElement.outerHTML.slice(-600)")}`)
	}
	await call('Runtime.enable', {})
	let close = async () => {
		ws.close()
		proc.kill()
		await proc.exited
		rmSync(dir, { recursive: true, force: true })
	}
	return { call, evaluate, waitFor, close, diagnostics }
}

// One Chrome for the file (a launch costs ~0.4 s). Closing a test's
// browser hands the page back blank: no cookies, storage or forced size.
let shared: ReturnType<typeof launch> | undefined
async function browser() {
	let b = await (shared ??= launch())
	let close = async () => {
		await b.evaluate('localStorage.clear()')
		await b.call('Network.clearBrowserCookies', {})
		await b.call('Emulation.clearDeviceMetricsOverride', {})
		await b.call('Page.navigate', { url: 'about:blank' })
		// The page logs no Solid reactivity diagnostics (task f09).
		expect(b.diagnostics.splice(0)).toEqual([])
	}
	return { ...b, close }
}
afterAll(async () => {
	if (shared) await (await shared).close()
})

// A browser test of provider streaming starts from an already-used home.
function providerHome(): void {
	let id = '1-ready'
	mkdirSync(paths.sessionDir(id))
	writeFileSync(`${paths.sessionDir(id)}/session.ason`, ason.stringify({ id, cwd: '/tmp', model: 'anthropic/claude-opus-5-5', createdAt: new Date().toISOString() }) + '\n')
}

test.skipIf(!chrome)('completion choices fit phone and desktop, and can be tapped', async () => {
	providerHome()
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
		// The textarea mounts before tab-start's snapshot. Background opens
		// must not make this test type before the focused tab is ready.
		await b.waitFor(`!!document.querySelector('.entry .hint')?.textContent`)
		for (let width of [390, 1280]) {
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: width === 390 })
			await b.call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width === 390 })
			await b.waitFor(`document.querySelector('.entry')?.getBoundingClientRect().bottom > 700`)
			// Prime the textarea's auto-height before comparing menu geometry:
			// the first typed character can change its native scrollHeight.
			await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.value = 'x'; t.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
			await b.evaluate(`new Promise(resolve => requestAnimationFrame(resolve))`)
			let frame = `(() => { let rect = (s) => document.querySelector(s).getBoundingClientRect(); return { transcript: rect('.Transcript').bottom, status: rect('.StatusRow').top, entry: rect('.entry').top, composer: rect('.Composer').top } })()`
			let before = await b.evaluate(frame)
			await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.value = '/c'; t.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
			await b.waitFor(`document.querySelectorAll('.completions [role=option]').length > 1`)
			let layout = await b.evaluate(`(() => { let r = document.querySelector('.completions').getBoundingClientRect(), box = document.querySelector('textarea').getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, boxTop: box.top, target: document.querySelector('.completions button').getBoundingClientRect().height, viewport: innerWidth } })()`)
			expect(layout.left).toBeGreaterThanOrEqual(0)
			expect(layout.right).toBeLessThanOrEqual(layout.viewport)
			expect(layout.bottom).toBeLessThanOrEqual(layout.boxTop)
			expect(layout.target).toBeGreaterThanOrEqual(44)
			expect(await b.evaluate(frame)).toEqual(before)
			let covered = await b.evaluate(`(() => {
				let menu = document.querySelector('.completions'), m = menu.getBoundingClientRect();
				return ['.StatusRow'].map((selector) => {
					let s = document.querySelector(selector).getBoundingClientRect(), y = (Math.max(m.top, s.top) + Math.min(m.bottom, s.bottom)) / 2;
					return { overlaps: m.top < s.bottom && m.bottom > s.top, onTop: menu.contains(document.elementFromPoint(m.left + m.width / 2, y)) };
				});
			})()`)
			expect(covered).toEqual([{ overlaps: true, onTop: true }])
			// A request for the next character must not make an unchanged menu
			// disappear for a frame or rebuild its rows when the answer arrives.
			await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.value = '/logi'; t.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
			await b.waitFor(`document.querySelector('.completions button')?.textContent.includes('/login') && document.querySelectorAll('.completions button').length === 1`)
			await b.evaluate(`(() => {
				let menu = document.querySelector('.completions'), row = menu.querySelector('button'), box = document.querySelector('textarea');
				window.__completionWatch = { menu, row, y: box.getBoundingClientRect().top, changes: 0 };
				let watch = window.__completionWatch;
				watch.observer = new MutationObserver((list) => { watch.changes += list.filter((m) => m.target === menu.parentNode || menu.contains(m.target)).length });
				watch.observer.observe(menu.parentNode, { subtree: true, childList: true, attributes: true, characterData: true });
				box.value = '/login'; box.dispatchEvent(new InputEvent('input', { bubbles: true }));
			})()`)
			await Bun.sleep(100)
			let stable = await b.evaluate(`(() => { let w = window.__completionWatch; w.observer.disconnect(); return { sameMenu: w.menu === document.querySelector('.completions'), sameRow: w.row === document.querySelector('.completions button'), connected: w.row.isConnected, changes: w.changes, y: document.querySelector('textarea').getBoundingClientRect().top - w.y } })()`)
			expect(stable).toEqual({ sameMenu: true, sameRow: true, connected: true, changes: 0, y: 0 })
			await b.evaluate(`document.querySelector('.completions button').click()`)
			await b.waitFor(`!document.querySelector('.completions')`)
			expect(await b.evaluate(frame)).toEqual(before)
			expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe('/login ')
			await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.value = ''; t.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
		}
	} finally { await b.close() }
}, 15000)


test.skipIf(!chrome)('in a browser earlier history loads above: shown cards stay, open ones stay open', async () => {
	// Turns taller than the window, one per page.
	let id = tabs.create('/tmp')
	for (let t = 0; t < 4; t++) {
		history.append(id, { type: 'user', blocks: [{ type: 'text', text: `prompt ${t}` }] })
		history.append(id, { type: 'assistant', block: { type: 'thinking', text: `thought ${t}` } })
		history.append(id, { type: 'assistant', block: { type: 'text', text: `reply ${t}\n`.repeat(80) } })
		history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	}
	pages.budget = 1500
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
		await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
		await b.call('Page.navigate', { url: `${base()}/${id}` })
		await b.waitFor(`document.querySelector('main')?.innerText.includes('thought 3') && !document.querySelector('main')?.innerText.includes('prompt 0')`)
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
	} finally {
		await b.close()
	}
}, 20000)

test.skipIf(!chrome)('in a browser a block address loads its page, marks its card and opens the whole output', async () => {
	// The linked tool result sits in the first turn, pages away from the tail.
	let id = tabs.create('/tmp')
	let output = Array.from({ length: 40 }, (_, i) => `row ${i + 1}`).join('\n')
	let { blob } = blobs.store(id, 'image/gif', 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'prompt 0' }, { type: 'image', blob, mediaType: 'image/gif' }] })
	history.append(id, { type: 'assistant', block: { type: 'tool_call', id: 'c0', name: 'bash', input: { command: 'seq 40\nprintf done', modifies: ['/tmp/example.log'], timeout: 120000, background: false, unfamiliar: { explanation: 'Keep this visible' } } } })
	let result = history.append(id, { type: 'user', blocks: [{ type: 'tool_result', id: 'c0', output }] })
	history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	for (let t = 1; t < 4; t++) {
		history.append(id, { type: 'user', blocks: [{ type: 'text', text: `prompt ${t}` }] })
		history.append(id, { type: 'assistant', block: { type: 'text', text: `reply ${t}\n`.repeat(80) } })
		history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	}
	pages.budget = 1500
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
			let link = card.querySelector('a.link')
			return { targets: document.querySelectorAll('.Card.target').length, visible: box.top < main.bottom && box.bottom > main.top, link: link && new URL(link.href).pathname + new URL(link.href).hash }
		})()`)
		expect(seen).toEqual({ targets: 1, visible: true, link: `/${id}#t${result.n! - 1}` })
		let inspection = await b.evaluate(`document.querySelector('.Card.target .contents').textContent`)
		expect(inspection).toContain('$ seq 40\n  printf done\nEdits /tmp/example.log')
		expect(inspection).toContain('Keep this visible')
		expect(inspection).not.toMatch(/\bc0\b|120000|Call ID/)

	} finally {
		await b.close()
	}
}, 20000)

test.skipIf(!chrome)('in a browser tabs are links; new, Back and close move the address; the strip stays one short row', async () => {
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
		await b.waitFor(`document.querySelectorAll('.Tabs .strip a.tab').length === 1 && /\\/\\d+-[a-z]{3}$/.test(location.pathname)`)
		let first = await b.evaluate(`location.pathname`)
		expect(await b.evaluate(`document.querySelector('.Tabs .strip a.tab').getAttribute('href')`)).toBe(first)
		await b.evaluate(`document.querySelector('.Tabs .strip .new').click()`)
		await b.waitFor(`document.querySelectorAll('.Tabs .strip a.tab').length === 2 && location.pathname !== '${first}'`)
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
		// A real click: focus moves, running focus handlers as the sheet opens.
		let menu = JSON.parse(await b.evaluate(`JSON.stringify(document.querySelector('.Tabs .menu').getBoundingClientRect())`))
		for (let type of ['mousePressed', 'mouseReleased']) await b.call('Input.dispatchMouseEvent', { type, x: menu.x + menu.width / 2, y: menu.y + menu.height / 2, button: 'left', clickCount: 1 })
		await b.waitFor(`document.querySelector('.Tabs .sheet').open`)
		expect(await b.evaluate(`document.activeElement === document.querySelector('.Tabs .sheet ul') && getComputedStyle(document.activeElement).outlineStyle === 'none'`)).toBe(true)
		expect(await b.evaluate(`document.querySelector('.Tabs .sheet [aria-current]').getAttribute('href')`)).toBe(second)
		await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
		await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
		expect(await b.evaluate(`document.activeElement === document.querySelector('.Tabs .sheet a') && document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle !== 'none'`)).toBe(true)
		await b.evaluate(`document.querySelector('.Tabs .sheet li:has([aria-current]) .close').click()`)
		await b.waitFor(`document.querySelectorAll('.Tabs .strip a.tab').length === 1 && location.pathname === '${first}'`)
		expect(await b.evaluate(`history.length`)).toBe(entries)
		// A phone: the same one row, its menu opening the sheet.
		await b.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true })
		expect(await b.evaluate(`document.querySelector('.Tabs').getBoundingClientRect().height < 50`)).toBe(true)
		await b.evaluate(`document.querySelector('.Tabs .sheet').open || document.querySelector('.Tabs .menu').click()`)
		await b.waitFor(`document.querySelector('.Tabs .sheet').open && document.querySelectorAll('.Tabs .sheet a').length === 1`)
		await b.evaluate(`document.querySelector('.Tabs .sheet .new').click()`)
		await b.waitFor(`!document.querySelector('.Tabs .sheet').open && location.pathname !== '${first}'`)
		expect(await b.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
		// The menu's Notifications sheet opens and closes.
		await b.evaluate(`document.querySelector('.Tabs .menu').click()`)
		await b.waitFor(`document.querySelector('.Tabs .sheet').open`)
		await b.evaluate(`[...document.querySelectorAll('.Tabs .sheet button')].find(b => b.textContent === 'Notifications').click()`)
		await b.waitFor(`document.querySelector('.Notifications').open && !document.querySelector('.Tabs .sheet').open`)
		await b.evaluate(`[...document.querySelectorAll('.Notifications button')].find(b => b.textContent === 'Close').click()`)
		await b.waitFor(`!document.querySelector('.Notifications').open`)
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
		await b.waitFor(`document.querySelector('main')?.innerText.includes('streaming now')`)
		await enter('/help')
		await b.waitFor(`(() => { let c = document.querySelector('.Card.pending'); return c && c.textContent.endsWith('/help') && !c.getAnimations().some((a) => !(a instanceof CSSTransition)) })()`)
		let moved = await b.evaluate(`(async () => {
			let card = document.querySelector('.Card.pending'), reply = document.querySelector('.Card.assistant')
			let before = !!(reply.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)
			window.letGo()
			for (let i = 0; i < 250 && (card.classList.contains('pending') || !card.nextElementSibling?.matches('.Card.output')); i++) await new Promise((r) => setTimeout(r, 10))
			let output = card.nextElementSibling
			return {
				wasAfter: before,
				same: card.isConnected && !card.classList.contains('pending'),
				nowBefore: !!(card.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING),
				// A colour easing back from pending is not a fade.
				fading: [card, reply].some((c) => c.getAnimations().some((a) => !(a instanceof CSSTransition))),
				// The output is new: it fades in.
				fresh: !!output && output.getAnimations().length > 0,
				copies: [...document.querySelectorAll('.Card.user')].filter((c) => c.textContent.endsWith('/help')).length,
			}
		})()`)
		expect(moved).toEqual({ wasAfter: true, same: true, nowBefore: true, fading: false, fresh: true, copies: 1 })
		release()
	} finally {
		await b.close()
	}
}, 20000)


test.skipIf(!chrome)('web tab paging scrolls with overlap without selecting, and selection recenters', async () => {
	providerHome()
	let ids = Array.from({ length: 21 }, () => sessions.create({ cwd: home }).id)
	tabs.file().open = ids
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true })
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
		await b.call('Page.navigate', { url: `${base()}/${ids[0]}?auth=${webAuth.issue()}` })
		await b.waitFor(`document.querySelectorAll('.track .tab').length === 21 && document.querySelector('.edge.left')?.disabled`)
		let geometry = `(() => {
			let track = document.querySelector('.track'), r = track.getBoundingClientRect(), links = [...track.querySelectorAll('.tab')];
			let visible = links.filter(a => { let t = a.getBoundingClientRect(); return t.left >= r.left - 1 && t.right <= r.right + 1 });
			let left = document.querySelector('.edge.left'), right = document.querySelector('.edge.right');
			return { first: links.indexOf(visible[0]), last: links.indexOf(visible.at(-1)), path: location.pathname, scroll: track.scrollLeft, leftDisabled: left.disabled, rightDisabled: right.disabled, opacity: getComputedStyle(left).opacity, target: left.getBoundingClientRect().width, height: left.getBoundingClientRect().height, offscreen: left.classList.contains('offscreen'), border: getComputedStyle(left).borderBottomWidth, weight: getComputedStyle(left).fontWeight, color: getComputedStyle(left).color, activeColor: getComputedStyle(track.querySelector('[aria-current]')).color, gap: Math.abs(visible[0].getBoundingClientRect().left - r.left), snap: getComputedStyle(track).scrollSnapType };
		})()`
		let scrollPage = (side: 'left' | 'right') => b.evaluate(`new Promise(resolve => { let track = document.querySelector('.track'); track.addEventListener('scrollend', () => requestAnimationFrame(resolve), { once: true }); document.querySelector('.edge.${side}').click() })`)
		let first = await b.evaluate(geometry)
		expect(first.first).toBe(0)
		expect(first.last).toBeGreaterThan(0)
		expect(first.opacity).toBe('0.5')
		expect(first.target).toBe(24)
		expect(first.height).toBeGreaterThanOrEqual(44)
		expect(first.gap).toBeLessThanOrEqual(1)
		expect(first.snap).toBe('x') // CSSOM omits the default proximity value.
		expect(await b.evaluate("[...document.querySelectorAll('.edge')].every(e => !/[0-9]/.test(e.textContent))")).toBe(true)
		// Native touch scrolling moves only the strip, not the active session.
		let swipe = await b.evaluate("(() => { let r = document.querySelector('.track').getBoundingClientRect(); return { x: r.right - 20, y: r.y + r.height / 2 } })()")
		await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [swipe] })
		for (let i = 1; i <= 8; i++) {
			await b.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: swipe.x - i * 15, y: swipe.y }] })
			await Bun.sleep(16)
		}
		await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
		await b.evaluate("new Promise(resolve => { let track = document.querySelector('.track'), last = track.scrollLeft, still = 0; let check = () => { let now = track.scrollLeft; still = now === last ? still + 1 : 0; last = now; if (still >= 10) resolve(); else requestAnimationFrame(check); }; requestAnimationFrame(check) })")
		await b.waitFor(`(${geometry}).scroll > 0`)
		expect((await b.evaluate(geometry)).path).toBe(`/${ids[0]}`)
		// Tapping the already selected tab reveals it again smoothly.
		await b.evaluate("new Promise(resolve => { document.querySelector('.track').addEventListener('scrollend', () => requestAnimationFrame(resolve), { once: true }); document.querySelector('.track [aria-current]').click() })")
		await b.waitFor(`(${geometry}).first === 0 && (${geometry}).leftDisabled`)
		await scrollPage('right')
		await b.waitFor(`(${geometry}).first === ${first.last} && (${geometry}).gap <= 1`)
		let next = await b.evaluate(geometry)
		expect(next.path).toBe(`/${ids[0]}`)
		expect(next.offscreen).toBe(true)
		expect(next.border).toBe('0px')
		expect(next.weight).toBe('700')
		expect(next.color).toBe(next.activeColor)
		// Urgent hidden status redraws its edge, but never recenters.
		status.transition(ids[0]!, { type: 'submit' })
		status.transition(ids[0]!, { type: 'end', error: 'test failure' })
		await b.waitFor("!!document.querySelector('.edge.left .failed')")
		expect((await b.evaluate(geometry)).scroll).toBeCloseTo(next.scroll, 0)
		await scrollPage('left')
		await b.waitFor(`(${geometry}).first === 0 && (${geometry}).leftDisabled`)
		// Select a hidden session using its native link; selection reveals it.
		await b.evaluate("new Promise(resolve => { document.querySelector('.track').addEventListener('scrollend', () => requestAnimationFrame(resolve), { once: true }); document.querySelectorAll('.track .tab')[10].click() })")
		await b.waitFor(`location.pathname === '/${ids[10]}' && (${geometry}).first > 0 && (${geometry}).last >= 10 && (${geometry}).first <= 10`)
		let centered = await b.evaluate(geometry)
		expect(Math.abs((centered.first + centered.last) / 2 - 10)).toBeLessThanOrEqual(.5)
		// Page all the way to the end without changing that selection.
		for (let i = 0; i < 21; i++) {
			let before = await b.evaluate(geometry)
			if (before.rightDisabled) break
			await scrollPage('right')
			await b.waitFor(`(${geometry}).first > ${before.first} && (${geometry}).gap <= 1`)
		}
		let end = await b.evaluate(geometry)
		expect(end.rightDisabled).toBe(true)
		expect(end.last).toBe(20)
		expect(end.path).toBe(`/${ids[10]}`)
	} finally {
		await b.close()
	}
}, 20000)

test.skipIf(!chrome)('compact status keeps two lines and opens full live details without losing the draft', async () => {
	providerHome()
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
		await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
		await b.waitFor("document.querySelector('.StatusRow .name')?.textContent.includes(': Session ')")
		let id = await b.evaluate("location.pathname.slice(1)")
		let meta = { id, cwd: '/tmp/very-long-parent-directory/project', model: 'fake/a-very-long-model-name', name: 'A long conversation name that must not wrap on a narrow phone', createdAt: new Date().toISOString() }
		host.broadcast(meta.id, { type: 'meta', sessionId: meta.id, meta, stats: { context: 85000, window: 100000, sent: 9000, received: 2000, files: 4, effort: 'medium', plan: { account: 1, accounts: 1, windows: { '5h': 17 } } } })
		host.broadcast(meta.id, { type: 'state', sessionId: meta.id, state: { type: 'running', phase: 'requesting' } })
		await b.waitFor("document.querySelector('.StatusRow .heat-85')?.textContent === '85%' && document.querySelector('.activity')?.textContent.includes('processing')")
		await b.evaluate("let draft = document.querySelector('textarea'); draft.value = 'draft survives details'; draft.dispatchEvent(new Event('input', { bubbles: true }))")
		for (let width of [320, 390, 1024, 1600]) {
			await b.call('Emulation.setDeviceMetricsOverride', { width, height: 760, deviceScaleFactor: 1, mobile: true })
			await b.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
			let geometry = await b.evaluate(`(() => {
				let q = s => document.querySelector(s), r = s => q(s).getBoundingClientRect();
				return { height: r('.overview').height, lineHeight: parseFloat(getComputedStyle(q('.overview')).lineHeight), primary: r('.primary').height, secondary: r('.secondary').height, overflow: document.documentElement.scrollWidth > innerWidth, cwd: q('.cwd').innerText, id: q('.id').checkVisibility() ? q('.id').innerText : '', windows: q('.windows').checkVisibility() ? q('.windows').innerText.replace(/\\s+/g, ' ') : '', fill: getComputedStyle(q('.model')).getPropertyValue('--fill'), duplicated: !!q('.Composer .status') };
			})()`)
			expect(geometry.height).toBeGreaterThanOrEqual(44)
			expect(geometry.primary).toBeLessThanOrEqual(geometry.lineHeight + 1)
			expect(geometry.secondary).toBeLessThanOrEqual(geometry.lineHeight + 1)
			expect(geometry.overflow).toBe(false)
			// Full cwd at every width; only id and windows depend on room.
			expect(geometry.cwd).toBe(meta.cwd)
			expect(geometry.id).toBe(width < 600 ? '' : `${id}: `)
			expect(geometry.windows).toBe(width < 600 ? '' : '5h 17% used')
			expect(geometry.fill).toBe('83%')
			expect(geometry.duplicated).toBe(false)
		}
		await b.evaluate("document.querySelector('.overview').focus()")
		await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
		await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
		await b.waitFor("document.querySelector('.StatusDetails').open")
		let text = await b.evaluate("document.querySelector('.StatusDetails').textContent")
		expect(text).toContain(meta.name)
		expect(text).toContain(meta.cwd)
		expect(text).toContain('medium')
		expect(text).toContain('5h 17%')
		expect(await b.evaluate("[...document.querySelectorAll('.StatusDetails a')].map(a => a.getAttribute('href'))")).toEqual([`/changes/${id}`, `/context/${id}`])
		host.broadcast(meta.id, { type: 'state', sessionId: meta.id, state: { type: 'paused' } })
		await b.waitFor("document.querySelector('.StatusDetails p').textContent.startsWith('paused')")
		await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
		await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
		await b.waitFor("!document.querySelector('.StatusDetails').open")
		expect(await b.evaluate("document.activeElement === document.querySelector('.overview')")).toBe(true)
		expect(await b.evaluate("document.querySelector('textarea').value")).toBe('draft survives details')
	} finally {
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
		await b.close()
	}
}, 20_000)

test.skipIf(!chrome)('phone landscape shrinks chrome and bounds long drafts as the visible viewport changes', async () => {
	providerHome()
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
		await b.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 760, deviceScaleFactor: 1, mobile: true })
		await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
		await b.waitFor("document.querySelector('textarea') && document.querySelector('.StatusRow .name')?.textContent.includes('Session ')")
		let draft = Array.from({ length: 30 }, (_, i) => `Draft line ${i}: preserve this text`).join('\n')
		await b.evaluate(`let t = document.querySelector('textarea'); t.value = ${JSON.stringify(draft)}; t.dispatchEvent(new Event('input', { bubbles: true }))`)
		let geometry = (height?: number) => b.evaluate(`(() => {
			${height ? `document.documentElement.style.setProperty('--app-height', '${height}px');` : ''}
			let q = s => document.querySelector(s), rect = s => q(s).getBoundingClientRect(), font = s => parseFloat(getComputedStyle(q(s)).fontSize);
			return { transcriptFont: font('.Transcript'), statusFont: font('.overview'), draftFont: font('textarea'), draftHeight: rect('textarea').height, scrollable: q('textarea').scrollHeight > q('textarea').clientHeight, transcriptHeight: rect('.Transcript').height, targets: [...document.querySelectorAll('.overview, .entry button')].every(e => e.getBoundingClientRect().height >= 44), overflow: document.documentElement.scrollWidth > innerWidth, value: q('textarea').value };
		})()`)
		let portrait = await geometry()
		expect(portrait.transcriptFont).toBe(14)
		expect(portrait.statusFont).toBeGreaterThan(11)
		expect(portrait.draftHeight).toBeGreaterThan(80)
		for (let [width, height] of [[844, 390], [667, 375]]) {
			await b.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
			let landscape = await geometry()
			expect(landscape.transcriptFont).toBe(12)
			expect(landscape.statusFont).toBe(11)
			expect(landscape.draftFont).toBe(16)
			expect(landscape.draftHeight).toBeLessThanOrEqual(80)
			expect(landscape.scrollable).toBe(true)
			expect(landscape.transcriptHeight).toBeGreaterThan(100)
			expect(landscape.targets).toBe(true)
			expect(landscape.overflow).toBe(false)
			expect(landscape.value).toBe(draft)
		}
		// Model the visible space left by a keyboard without changing the draft.
		let keyboard = await geometry(180)
		expect(keyboard.draftHeight).toBeLessThanOrEqual(45)
		expect(keyboard.transcriptHeight).toBeGreaterThan(10)
		expect(keyboard.value).toBe(draft)
		await b.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 760, deviceScaleFactor: 1, mobile: true })
		await b.waitFor("document.querySelector('.App').getBoundingClientRect().height >= 750")
		expect((await geometry()).draftHeight).toBeGreaterThan(80)
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
		await b.call('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: false })
		let desktop = await geometry()
		expect(desktop.transcriptFont).toBe(14)
		expect(desktop.statusFont).toBe(portrait.statusFont)
	} finally {
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
		await b.close()
	}
}, 20000)

test.skipIf(!chrome)('rotation preserves exclusive 40px edge gaps or the text at the viewport centre', async () => {
	providerHome()
	let id = tabs.create('/tmp')
	let longReply = Array.from({ length: 100 }, (_, i) => `Paragraph ${i}: the separate activity row is gone. This uniquely numbered paragraph has enough text to wrap differently after rotating the phone, while its words retain their identity.`).join('\n\n')
	turns.stream = () => (async function* (): AsyncGenerator<StreamEvent> { yield { type: 'text', text: longReply }; yield { type: 'done', reason: 'end' } })()
	let b = await browser()
	try {
		await server.serve(); web.start()
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
		await b.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 760, deviceScaleFactor: 1, mobile: true })
		await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
		await b.call('Page.navigate', { url: `${base()}/${id}` })
		await b.waitFor("document.querySelector('.StatusRow .name')?.textContent.includes('Session ')")
		await b.evaluate("let t = document.querySelector('textarea'); t.value = 'reply'; t.dispatchEvent(new Event('input', { bubbles: true }))")
		await b.evaluate("document.querySelector('.entry .actions button').click()")
		await b.waitFor("document.querySelector('main')?.textContent.includes('Paragraph 99:') && document.querySelector('.activity').textContent.includes('idle')")
		let resize = async (landscape: boolean) => {
			let width = landscape ? 844 : 390, height = landscape ? 390 : 760
			await b.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
			await b.waitFor(`document.querySelector('.App').clientWidth === ${width} && document.querySelector('.App').clientHeight === ${height}`)
			await b.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
		}
		let position = async (edge: 'top' | 'bottom' | 'middle', distance = 0) => {
			await b.evaluate(`(() => {
				let el = document.querySelector('main'); el.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
				el.scrollTop = ${edge === 'top' ? distance : edge === 'bottom' ? `el.scrollHeight - el.clientHeight - ${distance}` : '(el.scrollHeight - el.clientHeight) * .45'};
			})()`)
			if (edge === 'middle') await b.evaluate(`(() => {
				let el = document.querySelector('main'), r = el.getBoundingClientRect();
				for (let d = 0; d < 40; d++) {
					let c = document.caretRangeFromPoint(r.left + el.clientWidth / 2, r.top + el.clientHeight / 2 + d);
					if (c?.startContainer.nodeType === Node.TEXT_NODE && c.startContainer.length) { el.scrollTop += d; break }
				}
			})()`)
			await b.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
		}
		let gap = (edge: 'top' | 'bottom') => b.evaluate(`(() => { let el = document.querySelector('main'); return ${edge === 'top' ? 'el.scrollTop' : 'el.scrollHeight - el.clientHeight - el.scrollTop'} })()`)
		let mark = () => b.evaluate(`(() => {
			let el = document.querySelector('main'), rect = el.getBoundingClientRect();
			let range;
			for (let distance = 0; distance <= 40 && !range; distance++) for (let sign of [-1, 1]) {
				let candidate = document.caretRangeFromPoint(rect.left + el.clientWidth / 2, rect.top + el.clientHeight / 2 + sign * distance);
				if (candidate?.startContainer.nodeType === Node.TEXT_NODE && candidate.startContainer.length) { range = candidate; break }
			}
			if (!range || range.startContainer.nodeType !== Node.TEXT_NODE || !range.startContainer.length) throw Error('No centre text');
			let node = range.startContainer, offset = Math.min(range.startOffset, node.length - 1);
			range.setStart(node, offset); range.setEnd(node, offset + 1); window.rotationMarker = range;
			let r = range.getBoundingClientRect(); return r.top + r.height / 2 - rect.top - el.clientHeight / 2;
		})()`)
		let markerOffset = () => b.evaluate(`(() => { let el = document.querySelector('main'), r = window.rotationMarker.getBoundingClientRect(); return r.top + r.height / 2 - el.getBoundingClientRect().top - el.clientHeight / 2 })()`)
		for (let landscape of [true, false]) {
			for (let edge of ['top', 'bottom'] as const) {
				for (let distance of [0, 10, 40]) {
					await resize(!landscape); await position(edge, distance); await resize(landscape)
					expect(Math.abs(await gap(edge) - distance)).toBeLessThanOrEqual(1)
				}
				// At 41px the centre wins, not that nearby edge.
				await resize(!landscape); await position(edge, 41)
				let offset = await mark(); await resize(landscape)
				// A leading arrival can put the centre target above scrollTop=0.
				// Unreachable targets must land at the corresponding edge (3y).
				let delta = await markerOffset() - offset
				let top = await gap('top'), max = top + await gap('bottom')
				let expectedTop = Math.max(0, Math.min(top + delta, max))
				expect(Math.abs(top - expectedTop)).toBeLessThanOrEqual(1)
			}
			await resize(!landscape); await position('middle')
			let offset = await mark(); await resize(landscape)
			expect(Math.abs(await markerOffset() - offset)).toBeLessThanOrEqual(1)
		}
		// A nearly fitting transcript is close to BOTH edges: preserve centre.
		// Restrict a new, naturally short conversation to 60px of overflow.
		turns.stream = () => (async function* (): AsyncGenerator<StreamEvent> { yield { type: 'text', text: 'Short paragraph one.\n\nShort paragraph two.\n\nShort paragraph three.\n\nShort paragraph four.' }; yield { type: 'done', reason: 'end' } })()
		await resize(false)
		let short = tabs.create('/tmp')
		let seed = host.connect(() => {})
		seed.send({ type: 'open', sessionId: short })
		seed.send({ type: 'submit', sessionId: short, text: 'short' })
		seed.close()
		await b.call('Page.navigate', { url: `${base()}/${short}` })
		await b.waitFor("document.querySelector('main')?.textContent.includes('Short paragraph four.') && document.querySelector('.activity').textContent.includes('idle')")
		await b.evaluate(`(() => { let el = document.querySelector('main'), last = el.lastElementChild; el.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); let contentHeight = last.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop + parseFloat(getComputedStyle(last).marginBottom) + parseFloat(getComputedStyle(el).paddingBottom); el.style.flex = 'none'; el.style.height = (contentHeight - 60) + 'px' })()`)
		await b.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
		await position('top', 30)
		expect(await gap('bottom')).toBeLessThanOrEqual(40)
		let offset = await mark()
		await b.evaluate("let el = document.querySelector('main'); el.style.height = (el.clientHeight + 10) + 'px'")
		await b.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
		expect(Math.abs(await markerOffset() - offset)).toBeLessThanOrEqual(1)
		await b.evaluate("document.querySelector('main').style.height = '600px'")
		await b.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
		expect(await gap('top')).toBe(0)
	} finally {
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
		await b.close()
	}
}, 20000)

test.skipIf(!chrome)('touch tab navigation does not focus the composer', async () => {
	providerHome()
	let b = await browser()
	try {
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
		await server.serve()
		web.start()
		await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
		await b.waitFor(`document.querySelector('textarea') && document.querySelector('.Tabs .strip [aria-current]')`)
		expect(await b.evaluate(`matchMedia('(pointer: coarse)').matches`)).toBe(true)
		expect(await b.evaluate(`document.activeElement === document.querySelector('textarea')`)).toBe(false)
		let first = await b.evaluate('location.pathname')
		// A question owns focus in this tab. Leaving it used to refocus the
		// composer as soon as the next tab had no question.
		await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.focus(); t.value = '/cd ${home}/missing'; t.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
		expect(await b.evaluate(`document.activeElement === document.querySelector('textarea')`)).toBe(true)
		await b.evaluate(`document.querySelector('.Composer .actions button').click()`)
		await b.waitFor(`document.querySelector('textarea').disabled`)
		await b.evaluate(`document.querySelector('.Tabs .strip .new').click()`)
		await b.waitFor(`location.pathname !== '${first}' && document.querySelector('textarea') && !document.querySelector('textarea').disabled`)
		expect(await b.evaluate(`document.activeElement === document.querySelector('textarea')`)).toBe(false)
		let second = await b.evaluate('location.pathname')
		await b.evaluate(`document.querySelector('.Tabs .strip a[href="${first}"]').click()`)
		await b.waitFor(`location.pathname === '${first}' && document.querySelector('textarea').disabled`)
		await b.evaluate(`document.querySelector('.Tabs .strip a[href="${second}"]').click()`)
		await b.waitFor(`location.pathname === '${second}' && !document.querySelector('textarea').disabled`)
		expect(await b.evaluate(`document.activeElement === document.querySelector('textarea')`)).toBe(false)
		await b.evaluate(`document.querySelector('textarea').focus()`)
		expect(await b.evaluate(`document.activeElement === document.querySelector('textarea')`)).toBe(true)
	} finally {
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
		await b.close()
	}
})

test.skipIf(!chrome)('pending question URLs are safe native links and wrap at phone and desktop widths', async () => {
	let id = sessions.create({ cwd: home, model: 'anthropic/claude-opus-5-5' }).id
	let url = `https://example.com/oauth?state=a_b&redirect_uri=https%3A%2F%2Fexample.org%2Fcallback&scope=${'user%3Aprofile+'.repeat(30)}#fragment`
	let text = `Open (${url}).\nThen paste code#state. <script>window.pwned=1</script> javascript:bad()`
	history.append(id, { type: 'question', id: 'q-links', form: { text, fields: [{ type: 'text', name: 'code' }, { type: 'choice', name: 'mode', options: ['Continue', 'Cancel'] }] }, from: { command: 'login', args: '' } })
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
		await b.waitFor(`!!document.querySelector('.Question .text a')`)
		let link = await b.evaluate(`(() => { let q = document.querySelector('.Question'), a = q.querySelector('.text a'); return { href: a.getAttribute('href'), target: a.target, rel: a.rel, text: q.querySelector('.text').textContent, links: q.querySelectorAll('a').length, scripts: q.querySelectorAll('script').length } })()`)
		expect(link).toEqual({ href: url, target: '_blank', rel: 'noopener noreferrer', text: `? ${text}`, links: 1, scripts: 0 })
		for (let width of [390, 1280]) {
			await b.call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width === 390 })
			await b.evaluate(`new Promise(resolve => requestAnimationFrame(resolve))`)
			expect(await b.evaluate(`(() => { let q = document.querySelector('.Question'); return q.scrollWidth <= q.clientWidth && document.documentElement.scrollWidth <= innerWidth })()`)).toBe(true)
		}
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
		await b.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
		expect(await b.evaluate(`[...document.querySelectorAll('.Question button')].every(b => b.getBoundingClientRect().height >= 44 && b.getBoundingClientRect().width >= 44)`)).toBe(true)
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
		await b.evaluate(`document.querySelector('.Question input').focus()`)
		for (let selector of ['.dismiss', 'a']) {
			await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 })
			await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 })
			expect(await b.evaluate(`document.activeElement === document.querySelector('.Question ${selector}')`)).toBe(true)
		}
		expect(history.readSync(id).some(r => r.type === 'answer')).toBe(false)
	} finally {
		await b.close()
	}
})

test.skipIf(!chrome)('manual reload notice preserves the draft and command actions stay distinct from steering', async () => {
	providerHome()
	let id = tabs.create('/tmp')
	let finish = () => {}
	turns.stream = () => (async function* (): AsyncGenerator<StreamEvent> {
		yield { type: 'text', text: 'Still working' }
		await new Promise<void>((resolve) => { finish = resolve })
		yield { type: 'done', reason: 'end' }
	})()
	let b = await browser()
	let build = web.build
	try {
		await server.serve(); web.start()
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
		await b.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 760, deviceScaleFactor: 1, mobile: true })
		await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
		await b.call('Page.navigate', { url: `${base()}/${id}` })
		await b.waitFor("document.querySelector('.activity')?.textContent.includes('idle')")
		let input = (text: string) => b.evaluate(`(() => { let t = document.querySelector('textarea'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`)
		let actions = () => b.evaluate("[...document.querySelectorAll('.Composer .actions button')].map(b => b.getAttribute('aria-label') ?? b.textContent)")
		await input('start')
		await b.evaluate("document.querySelector('.Composer .actions button').click()")
		await b.waitFor("document.querySelector('main').textContent.includes('Still working')")
		await input('later')
		expect(await actions()).toEqual(['Pause (Esc)', 'Queue', 'Steer'])
		await input('/model')
		expect(await actions()).toEqual(['Pause (Esc)', 'Run'])
		expect(await b.evaluate("document.querySelector('.Composer .help').textContent.includes('queue')")).toBe(false)
		await input('draft stays put')
		await b.evaluate("document.querySelector('textarea').focus(); window.__beforeUpdate = document.querySelector('.Chat'); window.__oldText = document.querySelector('textarea'); window.__transcriptRect = document.querySelector('.Transcript').getBoundingClientRect().toJSON()")
		let page = await web.state.page!
		web.build = async () => ({ html: page.html.replace(`data-version="${page.version}"`, 'data-version="updated"'), version: 'updated' })
		await web.refresh()
		await b.waitFor("document.querySelector('.source-update button')?.textContent === 'reload'")
		let geometry = await b.evaluate(`(() => {
			let button = document.querySelector('.source-update button'), r = button.getBoundingClientRect(), tabs = document.querySelector('.Tabs').getBoundingClientRect();
			let transcript = document.querySelector('.Transcript').getBoundingClientRect();
			return { unchanged: transcript.top === window.__transcriptRect.top && transcript.height === window.__transcriptRect.height, overlay: r.top >= transcript.top && r.bottom <= transcript.bottom, background: getComputedStyle(button).backgroundColor, anchor: document.querySelector('.source-update').getBoundingClientRect().height, font: getComputedStyle(button).fontSize, border: getComputedStyle(button).borderTopWidth, height: r.height, width: r.width, clear: r.top >= tabs.bottom, focused: document.activeElement === window.__oldText, same: document.querySelector('.Chat') === window.__beforeUpdate, draft: document.querySelector('textarea').value };
		})()`)
		expect(geometry).toMatchObject({ unchanged: true, overlay: true, anchor: 0, font: '16px', border: '0px', clear: true, focused: true, same: true, draft: 'draft stays put' })
		expect(geometry.background).toContain('0.75')
		expect(geometry.height).toBeGreaterThanOrEqual(24)
		expect(geometry.width).toBeGreaterThanOrEqual(44)
		// A second rebuild keeps one persistent notice and the same page.
		await web.refresh()
		expect(await b.evaluate("document.querySelectorAll('.source-update').length")).toBe(1)
		finish()
		await b.waitFor("document.querySelector('.activity').textContent.includes('idle')")
		await input('/help')
		expect(await actions()).toEqual(['Run'])
		await input('draft stays put')
		await b.evaluate("document.querySelector('.source-update button').click()")
		await b.waitFor("!window.__beforeUpdate && document.querySelector('textarea')?.value === 'draft stays put'")
		expect(await b.evaluate("document.querySelector('.source-update') === null")).toBe(true)
	} finally {
		finish()
		web.build = build
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
		await b.close()
	}
}, 20000)

test.skipIf(!chrome)('completion dismissal follows pointer and focus without stealing choice clicks or Enter', async () => {
	providerHome()
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
		await b.waitFor(`!!document.querySelector('.entry .hint')?.textContent`)
		let type = async (text: string) => {
			await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.focus(); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
		}
		let open = async () => {
			await type('')
			await type('/c')
			await b.waitFor(`!!document.querySelector('.completions')`)
		}
		let press = (key: string) => b.call('Input.dispatchKeyEvent', { type: 'keyDown', key })
		await open()
		expect(await b.evaluate(`document.querySelector('.help').textContent`)).toContain('choose')
		await press('Enter')
		await b.waitFor(`!document.querySelector('.completions')`)
		expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe('/cd ')
		await open()
		// Keyboard focus within the popup must retain it until the click.
		await b.evaluate(`document.querySelector('.completions button').focus()`)
		expect(await b.evaluate(`!!document.querySelector('.completions')`)).toBe(true)
		await b.evaluate(`document.activeElement.click()`)
		await b.waitFor(`!document.querySelector('.completions')`)
		expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe('/cd ')
		// Model Safari's button default: blur the editor without focusing
		// the option. Cancelled gestures must retain both menu and draft.
		for (let pointerType of ['mouse', 'touch']) {
			await open()
			let retained = await b.evaluate(`(() => {
				let box = document.querySelector('textarea'), row = document.querySelector('.completions button');
				if (row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: '${pointerType}' }))) box.blur();
				row.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: '${pointerType}' }));
				return { focused: document.activeElement === box, menu: row.isConnected, text: box.value };
			})()`)
			expect(retained).toEqual({ focused: true, menu: true, text: '/c' })
		}
		// A real touch tap still produces click after pointerdown cancellation.
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
		await open()
		let point = await b.evaluate(`(() => { let r = document.querySelector('.completions button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
		await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
		expect(await b.evaluate(`document.activeElement === document.querySelector('textarea') && !!document.querySelector('.completions')`)).toBe(true)
		await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
		await b.waitFor(`!document.querySelector('.completions')`)
		expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe('/cd ')
		expect(history.readSync(await b.evaluate(`location.pathname.slice(1)`)).some(r => r.type === 'user')).toBe(false)
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
		for (let action of [
			`document.querySelector('[aria-label="Attach file"]').focus()`,
			`document.querySelector('textarea').blur()`,
			`document.querySelector('.Transcript').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }))`,
		]) {
			await open()
			await b.evaluate(action)
			await b.waitFor(`!document.querySelector('.completions')`)
			expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe('/c')
		}
		// Departure before the host reply must also suppress it.
		await type('')
		await b.evaluate(`(() => { let t = document.querySelector('textarea'); t.focus(); t.value = '/c'; t.dispatchEvent(new InputEvent('input', { bubbles: true })); document.querySelector('[aria-label="Attach file"]').focus() })()`)
		await Bun.sleep(100)
		expect(await b.evaluate(`!!document.querySelector('.completions')`)).toBe(false)
		expect(await b.evaluate(`document.activeElement.getAttribute('aria-label')`)).toBe('Attach file')
		// Exact restart commands offer described scopes without changing Enter.
		for (let width of [390, 1280]) {
			await b.call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width === 390 })
			for (let text of ['/restart', '/restart ']) {
				await type(text)
				await b.waitFor(`document.querySelectorAll('.completions button').length === 4`)
				expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe(text)
				expect(await b.evaluate(`document.querySelector('.completions button').textContent`)).toContain('(default)')
				expect(await b.evaluate(`document.querySelector('.help').textContent`)).toContain('run')
				let bounds = await b.evaluate(`(() => { let r = document.querySelector('.completions').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: innerWidth }; })()`)
				expect(bounds.left).toBeGreaterThanOrEqual(0)
				expect(bounds.right).toBeLessThanOrEqual(bounds.width)
				expect(bounds.top).toBeGreaterThanOrEqual(0)
				await press('Tab')
				await b.waitFor(`document.querySelector('textarea').value === '/restart all' && !document.querySelector('.completions')`)
			}
		}
		await type('/version')
		await b.waitFor(`!!document.querySelector('.completions')`)
		expect(await b.evaluate(`document.querySelector('.help').textContent`)).toContain('run')
		await press('Enter')
		await b.waitFor(`document.querySelector('textarea').value === ''`)
	} finally { await b.close() }
}, 15000)


test.skipIf(!chrome)('transcript card variants share first-line geometry in open and closed states', async () => {
	let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
	let ts = '2026-10-02T06:20:00Z'
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'Human prompt body' }], ts })
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'Delivered queued prompt body', queuedAt: '2026-10-01T23:13:07.456Z' }], queued: true, ts })
	history.append(id, { type: 'assistant', block: { type: 'text', text: 'Assistant body\n\nAnother paragraph' }, ts })
	history.append(id, { type: 'output', text: 'Command output body', ts })
	history.append(id, { type: 'command', text: '/help', ts })
	let { blob } = blobs.store(id, 'image/gif', 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
	history.append(id, { type: 'user', blocks: [{ type: 'image', blob, mediaType: 'image/gif' }], ts })
	history.append(id, { type: 'question', id: 'answered', form: { text: 'Choose an option', fields: [{ type: 'choice', name: 'choice', options: ['Yes', 'No'] }] }, ts })
	history.append(id, { type: 'answer', question: 'answered', answers: { choice: 'Yes' }, ts })

	history.append(id, { type: 'assistant', block: { type: 'thinking', text: 'Consider the layout\n\nFurther thought' }, ts })
	for (let [name, description] of [['short', 'Inspect files'], ['long', 'Put the one-space gap inside the timestamp tap target and rerun all checks before documenting the consistent card layout']]) {
		history.append(id, { type: 'assistant', block: { type: 'tool_call', id: name!, name: 'bash', input: { description, command: 'printf example', modifies: [] } }, ts })
		history.append(id, { type: 'user', blocks: [{ type: 'tool_result', id: name!, output: 'Example output' }], ts })
	}
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: '**Message body**\n\nMore detail', from: 'reviewer', label: 'Review agent', summary: 'Review the card layout', queuedAt: '2026-10-01T23:13:07.456Z' }], queued: true, ts })
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: '[exit 0]\nJob complete', from: 'worker', label: 'bash #6' }], ts })
	history.append(id, { type: 'inbox', id: 'queued-review', text: '**Queued message**\n\nLine three\nLine four', queue: true, from: 'reviewer', label: 'Review agent', ts })
	history.append(id, { type: 'compact', summary: 'Example context summary', prompts: 1, ts })
	history.append(id, { type: 'turn_end', status: 'paused', usage: {}, ts })
	history.append(id, { type: 'turn_end', status: 'error', error: 'Example turn failure', usage: {}, ts })
	let b = await browser()
	try {
		await server.serve(); web.start()
		await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
		await b.waitFor(`document.querySelectorAll('.Card.folds').length === 4 && !!document.querySelector('.Card.queued')`)
		// A streaming card's cursor sits in its header and must not shift the label.
		await b.evaluate(`document.querySelector('.Card.thinking .CardHeader .title').insertAdjacentHTML('beforeend', '<span class="cursor"></span>')`)
		let geometry = `(() => {
			let first = el => { let w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), n; while (n = w.nextNode()) if (n.textContent.trim()) { let r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 1); return r.getBoundingClientRect().toJSON() } };
			let last = el => { let w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), n, end; while (n = w.nextNode()) if (n.textContent.trim()) end = n; if (!end) return; let i = end.textContent.trimEnd().length, r = document.createRange(); r.setStart(end, i - 1); r.setEnd(end, i); return r.getBoundingClientRect().toJSON() };
			return [...document.querySelectorAll('.CardHeader')].map(h => {
				let c = h.closest('.Card'), stamp = h.querySelector('.stamp'), title = h.querySelector('.title'), ref = h.querySelector('.link');
				let t = first(stamp ?? title), label = first(title), link = ref?.getBoundingClientRect(), box = h.getBoundingClientRect(), body = c.querySelector(':scope > .content'), end = body && last(body);
				return { compact: c.classList.contains('thinking') || c.classList.contains('assistant'), folds: c.classList.contains('folds'), height: c.getBoundingClientRect().height, offCentre: t.y + t.height / 2 - (c.getBoundingClientRect().y + c.getBoundingClientRect().height / 2), rowHeight: box.height, inset: t.y - c.getBoundingClientRect().y, baseline: label ? label.y - t.y : 0, refTop: link ? link.y - box.y : 0, overlap: !!link && title.getBoundingClientRect().right > link.left + 1, textWidth: c.scrollWidth, boxWidth: c.clientWidth, tail: end ? c.getBoundingClientRect().bottom - end.bottom : undefined };
			});
		})()`
		for (let [, width, height, touch] of [['portrait', 390, 800, true], ['narrow', 320, 760, true], ['landscape', 844, 390, true], ['desktop', 1200, 800, false]] as const) {
			await b.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch })
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: touch })
			await b.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
			let thinking = await b.evaluate(`(() => { let c = document.querySelector('.Card.thinking'); return { text: c.querySelector('.title').textContent, name: c.querySelector('.mark').getAttribute('aria-label') } })()`)
			expect(thinking.text).toBe('Consider the layout')
			expect(thinking.name).toBe('Thinking: Consider the layout')
			// Untinted cards (thinking, model text) share a half inset, the rest one.
			let closed = await b.evaluate(geometry)
			let base = (row: any) => closed.find((r: any) => r.compact === row.compact).inset
			expect(closed.find((r: any) => r.compact).inset).toBeLessThan(closed.find((r: any) => !r.compact).inset)
			let folded = closed.filter((r: any) => r.folds && !r.compact)
			for (let row of closed) {
				expect(Math.abs(row.baseline)).toBeLessThanOrEqual(1)
				expect(row.inset).toBeCloseTo(base(row), 1)
				expect(row.refTop).toBe(0)
				expect(row.overlap).toBe(false)
				expect(row.textWidth).toBeLessThanOrEqual(row.boxWidth + 1)
			}
			for (let row of folded) expect(row.height).toBeCloseTo(folded[0].height, 1)
			// Every screen shares one geometry: a 44px header row centring its
			// line, and a body ending with the header's top inset.
			expect(folded[0].height).toBeCloseTo(44, 1)
			for (let row of folded.filter((r: any) => r.height < 50)) expect(Math.abs(row.offCentre)).toBeLessThanOrEqual(1.5)
			for (let row of closed.filter((r: any) => r.tail !== undefined)) expect(Math.abs(row.tail - row.inset)).toBeLessThanOrEqual(1.5)
			await b.evaluate(`document.querySelectorAll('.Card.folds .mark').forEach(b => b.click()); document.querySelector('.Card.queued').click()`)
			await b.waitFor(`document.querySelectorAll('.Card.folds.open').length === 4 && !!document.querySelector('.Card.queued .CardHeader')`)
			await Bun.sleep(300)
			for (let row of await b.evaluate(geometry)) {
				expect(Math.abs(row.baseline)).toBeLessThanOrEqual(1)
				expect(row.inset).toBeCloseTo(base(row), 1)
				expect(row.refTop).toBe(0)
				expect(row.overlap).toBe(false)
				expect(row.textWidth).toBeLessThanOrEqual(row.boxWidth + 1)
			}
			expect(await b.evaluate(`document.querySelector('.Card.thinking .title').textContent`)).toBe('Thinking')
			expect(await b.evaluate(`document.querySelector('.Card.thinking .content').textContent`)).toContain('Further thought')
			let insets = await b.evaluate(`(() => { let c = document.querySelectorAll('.Card.tool')[1], header = c.querySelector('.stamp'), body = c.querySelector('.content'); return { body: body.getBoundingClientRect().x + parseFloat(getComputedStyle(body).paddingLeft), header: header.getBoundingClientRect().x, wrapped: c.querySelector('.title').getBoundingClientRect().height > parseFloat(getComputedStyle(c).lineHeight) * 2, } })()`)
			expect(insets.body).toBeCloseTo(insets.header, 1)
			if (width <= 390) expect(insets.wrapped).toBe(true)

			await b.evaluate(`document.querySelectorAll('.Card.folds .mark').forEach(b => b.click()); document.querySelector('.Card.queued').click()`)
			await Bun.sleep(300)
		}

	} finally {
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
		await b.close()
	}
}, 15000)

// Selection belongs to the browser: tests may inspect it; rendering must not.
test.skipIf(!chrome)('streaming preserves native selection and Markdown text nodes without holding updates', async () => {
	providerHome()
	let b = await browser(), release = () => {}
	try {
		await server.serve()
		web.start()
		let id = tabs.create('/tmp')
		await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
		await b.call('Page.navigate', { url: `${base()}/${id}` })
		await b.waitFor(`!!document.querySelector('textarea') && !!document.querySelector('.StatusRow')`)
		for (let [seed, delta, selector] of [
			['alpha bravo', ' charlie', '.line span span'],
			['alpha bravo\n\nLater paragraph', ' charlie', '.line span span'],
			['**alpha bravo', ' charlie**', '.b'],
			['```txt\nalpha bravo', ' charlie\n```', 'code'],
			['https://example.com/alpha', '/bravo', '.Markdown a'],
			['| Name | Value |\n|---|---|\n| alpha | bravo |\n| charlie', ' | delta |\n\nnext', 'td span'],
		]) {
			let advance = () => {}, gate = new Promise<void>((r) => { advance = r })
			let finish = new Promise<void>((r) => { release = r })
			turns.stream = () => (async function* (): AsyncGenerator<StreamEvent> {
				yield { type: 'text', text: seed! }
				await gate
				yield { type: 'text', text: delta! }
				await finish
				yield { type: 'done', reason: 'end' }
			})()
			await b.waitFor(`getSelection().removeAllRanges(); (() => { let t = document.querySelector('textarea'); t.value = 'selection'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return !document.querySelector('#notice').textContent })()`)
			await b.waitFor(`!![...document.querySelectorAll('.Card.assistant')].at(-1)?.querySelector('.cursor')`)
			await b.evaluate(`(() => {
				let root = [...document.querySelectorAll('.Card.assistant')].at(-1)
				window.selectedElement = root.querySelector(${JSON.stringify(selector)})
				window.selectedNode = selectedElement.firstChild
				let range = document.createRange(); range.setStart(selectedNode, 1); range.setEnd(selectedNode, 4)
				getSelection().removeAllRanges(); getSelection().addRange(range)
				window.selectedText = getSelection().toString()
			})()`)
			let check = () => b.evaluate(`(() => {
				let s = getSelection(), r = s.getRangeAt(0)
				return { element: selectedElement.isConnected, node: selectedElement.firstChild === selectedNode,
					start: r.startContainer === selectedNode && r.startOffset === 1,
					end: r.endContainer === selectedNode && r.endOffset === 4, text: s.toString() === selectedText }
			})()`)
			advance()
			await b.waitFor(`[...document.querySelectorAll('.Card.assistant')].at(-1)?.innerText.includes(${JSON.stringify(selector === 'td span' ? 'delta' : delta!.includes('charlie') ? 'charlie' : '/bravo')})`)
			expect(await check()).toEqual({ element: true, node: true, start: true, end: true, text: true })
			release()
			await b.waitFor(`!!document.querySelector('.cursor-line')`)
			expect(await check()).toEqual({ element: true, node: true, start: true, end: true, text: true })
		}
	} finally {
		release()
		await b.close()
	}
}, 20000)

test('/logout targets every socket of one login, persists refusal, and leaves other logins connected', async () => {
	await server.serve(); web.start()
	let first = await cookie()
	let id = webAuth.list()[0]!.id
	let second = await cookie()
	let a = await dial(first), b = await dial(first), other = await dial(second)
	await until(() => [a, b, other].every((w) => w.events.some((e) => e.type === 'tabs')))
	let caller = sessions.create({ cwd: home, model: 'hal/intro' }).id
	let { command } = await import('./commands/logout.ts')
	expect(command.run(id, undefined, { sessionId: caller, cwd: home, model: 'hal/intro', setCwd() {}, setModel() {}, say() {} })).toMatchObject({ say: '1 web login(s) revoked; a browser needs a new code' })
	expect(await a.closed).toBe(4001); expect(await b.closed).toBe(4001)
	expect(other.ws.readyState).toBe(WebSocket.OPEN)
	webAuth.close()
	expect((await fetch(`${base()}/login`, { headers: { cookie: first } })).status).toBe(401)
	expect((await dial(first)).opened).toBe(false)
	expect((await fetch(`${base()}/login`, { headers: { cookie: second } })).status).toBe(204)
	command.run('all', undefined, { sessionId: caller, cwd: home, model: 'hal/intro', setCwd() {}, setModel() {}, say() {} })
	expect(await other.closed).toBe(4001)
})

test('self logout is same-origin POST only and cannot revoke another login', async () => {
	await server.serve(); web.start()
	let first = await cookie(), second = await cookie()
	let a = await dial(first), other = await dial(second)
	expect((await fetch(`${base()}/logout`, { headers: { cookie: first } })).status).toBe(404)
	expect((await fetch(`${base()}/logout`, { method: 'POST', headers: { cookie: first, origin: 'https://example.com' } })).status).toBe(403)
	expect(webAuth.list()).toHaveLength(2)
	let res = await fetch(`${base()}/logout`, { method: 'POST', headers: { cookie: first, origin: base() }, redirect: 'manual' })
	expect(res.status).toBe(303)
	expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
	expect(await a.closed).toBe(4001)
	expect(other.ws.readyState).toBe(WebSocket.OPEN)
	expect((await fetch(`${base()}/login`, { headers: { cookie: first } })).status).toBe(401)
})

test.skipIf(!chrome)('browser status logout fits phone and desktop and returns to the login gate', async () => {
	providerHome()
	let b = await browser()
	try {
		await server.serve(); web.start()
		await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
		await b.waitFor(`!!document.querySelector('.entry .hint')?.textContent`)
		for (let width of [390, 1280]) {
			await b.call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width === 390 })
			await b.evaluate(`document.querySelector('.StatusRow .overview').click()`)
			await b.waitFor(`document.querySelector('.StatusDetails').open`)
			let r = await b.evaluate(`(() => { let b = document.querySelector('.StatusDetails form button'), r = b.getBoundingClientRect(); return { text: b.textContent, height: r.height, left: r.left, right: r.right, viewport: innerWidth }; })()`)
			expect(r.text).toBe('Log out this browser')
			expect(r.height).toBeGreaterThanOrEqual(44)
			expect(r.left).toBeGreaterThanOrEqual(0); expect(r.right).toBeLessThanOrEqual(r.viewport)
			await b.evaluate(`document.querySelector('.StatusDetails').close()`)
		}
		await b.evaluate(`document.querySelector('.StatusRow .overview').click(); document.querySelector('.StatusDetails form button').click()`)
		await b.waitFor(`!!document.querySelector('.Login')`)
		expect(webAuth.list()).toHaveLength(0)
	} finally { await b.close() }
}, 15000)

test('revocation while an upgrade awaits the page build refuses the socket', async () => {
	await server.serve(); web.start()
	let auth = await cookie()
	let original = web.version
	let waiting = false
	let release!: (v: string) => void
	web.version = () => { waiting = true; return new Promise((r) => { release = r }) }
	try {
		let pending = dial(auth, '?v=building&updates=manual')
		await until(() => waiting)
		web.revoke(webAuth.list()[0]!.id)
		release('building')
		expect((await pending).opened).toBe(false)
		expect(web.state.sockets.size).toBe(0)
	} finally { web.version = original }
})
