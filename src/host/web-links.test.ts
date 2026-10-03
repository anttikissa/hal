import { afterEach, beforeEach, expect, test } from 'bun:test'
import { synthetic } from './synthetic.ts'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import type { Event } from '../common/protocol.ts'
import { settings } from '../common/settings.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { webAuth } from './web-auth.ts'
import { webLinks } from './web-links.ts'
import { statusUsage } from './status-usage.ts'
import { web } from './web.ts'

const savedHome = process.env.HAL_HOME
const origRenew = webLinks.renewMs
let home = ''

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-web-links-`)
	process.env.HAL_HOME = home
	paths.init()
})

afterEach(() => {
	webLinks.renewMs = origRenew
	settings.state.raw = {}
	webAuth.close()
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

async function until(check: () => unknown): Promise<void> {
	for (let i = 0; i < 500; i++) {
		if (check()) return
		await Bun.sleep(2)
	}
	throw new Error('timed out')
}

function client() {
	let events: Event[] = []
	let conn = host.connect((e) => events.push(e))
	let codes = () => events.flatMap((e) => (e.type === 'auth' && e.link !== undefined ? [e] : []))
	return { conn, events, codes }
}

// A click on a link: the code redeemed as web.ts does for ?auth=.
const click = (code: string) => web.redeem(code, new Request('http://localhost/', { headers: { host: 'localhost' } }))

test('a terminal gets the web address and a link code, a new one once it is used', () => {
	settings.state.raw = { webUrl: 'https://h2.example/' }
	let a = client()
	let b = client()
	a.conn.send({ type: 'auth', link: true, id: 'c1' })
	b.conn.send({ type: 'auth', link: true })
	expect(a.codes()).toEqual([{ type: 'auth', code: expect.any(String), link: 'https://h2.example' }])
	let first = a.codes()[0]!.code
	expect(b.codes()[0]!.code).not.toBe(first)
	expect(click(first).cookie).toBeDefined()
	expect(a.codes()).toHaveLength(2)
	expect(a.codes()[1]!.code).not.toBe(first)
	// Only the holder of the used code gets a new one.
	expect(b.codes()).toHaveLength(1)
	// A plain auth (./run auth) is a one-off code and no link code.
	a.conn.send({ type: 'auth' })
	expect(a.events.at(-1)).toEqual({ type: 'auth', code: expect.any(String) })
	expect(a.codes()).toHaveLength(2)
})

test('a link code is replaced before it is half its life old, and the old one still works', async () => {
	expect(webLinks.renewMs()).toBeLessThanOrEqual(webAuth.codeMs - 5 * 60_000)
	webLinks.renewMs = () => 5
	let a = client()
	a.conn.send({ type: 'auth', link: true })
	await until(() => a.codes().length >= 3)
	expect(new Set(a.codes().map((e) => e.code)).size).toBe(a.codes().length)
	expect(click(a.codes()[0]!.code).cookie).toBeDefined()
	// A closed connection gets no more codes.
	a.conn.close()
	let n = a.codes().length
	await Bun.sleep(30)
	expect(a.codes().length).toBe(n)
	expect(webLinks.state.holders.size).toBe(0)
})

test('no link code reaches any file of the home', async () => {
	let pace = synthetic.pauseMs
	synthetic.pauseMs = 0
	let a = client()
	a.conn.send({ type: 'create', cwd: home, model: 'hal/intro' })
	let id = (a.events.find((e) => e.type === 'snapshot') as { sessionId: string }).sessionId
	a.conn.send({ type: 'auth', link: true })
	a.conn.send({ type: 'submit', sessionId: id, text: 'hello' })
	a.conn.send({ type: 'draft', sessionId: id, text: 'typing' })
	await until(() => a.events.some((e) => e.type === 'question'))
	click(a.codes()[0]!.code)
	let files = readdirSync(home, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
	let all = files.map((d) => readFileSync(`${d.parentPath}/${d.name}`, 'latin1')).join('\n')
	expect(files.some((d) => d.name.endsWith('.asonl'))).toBe(true)
	for (let { code } of a.codes()) expect(all).not.toContain(code)
	synthetic.pauseMs = pace
})

test('a busy preferred web port falls back; the advertised URL and link codes follow the bound port', async () => {
	let a = client()
	a.conn.send({ type: 'auth', link: true })
	expect(a.codes()[0]!.link).toBe(`http://localhost:${settings.webPort()}`)
	// The preferred port is taken (say by another Hal), so the server moves on.
	// web.start tries ports up to 9100, so take one below it.
	let busy!: ReturnType<typeof Bun.serve>
	for (let port = 9050; !busy && port < 9099; port++) {
		try { busy = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() }) } catch {}
	}
	let port = busy.port
	if (port === undefined) throw new Error('server did not report its bound port')
	let origPort = web.port
	web.port = () => port
	try {
		web.start()
		let bound = web.state.server!.port!
		expect(bound).toBeGreaterThan(port)
		expect((await fetch(`http://127.0.0.1:${bound}/`)).status).toBe(200)
		expect(settings.webUrl()).toBe(`http://localhost:${bound}`)
		expect(statusUsage.runtime()).toContain(`Web: port ${bound}`)
		expect(a.codes().at(-1)!.link).toBe(`http://localhost:${bound}`)
	} finally {
		web.port = origPort
		await web.stop()
		busy.stop(true)
	}
})
