import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import type { Event } from '../common/protocol.ts'
import { transcript, type Transcript } from '../common/transcript.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { webAuth } from './web-auth.ts'
import { web } from './web.ts'

const savedHome = process.env.HAL_HOME
const origPort = web.port
let home = ''

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-web-auth-`)
	process.env.HAL_HOME = home
	paths.init()
	web.port = () => 0
})

afterEach(async () => {
	await server.stop()
	webAuth.close()
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	web.port = origPort
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
	let views = new Map<string, Transcript>()
	let conn = host.connect((e: Event) => {
		let id = 'sessionId' in e ? e.sessionId : undefined
		let t = id ? transcript.fold(views.get(id), e) : undefined
		if (id && t) views.set(id, t)
	})
	return { conn, views }
}

const outputs = (t: Transcript | undefined) => (t?.items ?? []).flatMap((i) => (i.type === 'output' ? [i.text] : []))

// Every file under `dir`, read as text.
function everyFile(dir: string): string {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((d) => d.isFile())
		.map((d) => readFileSync(`${d.parentPath}/${d.name}`, 'latin1'))
		.join('\n')
}

test('/auth shows every follower a working code that no file and no later snapshot holds', async () => {
	let a = client()
	a.conn.send({ type: 'create', cwd: home, model: 'hal/intro' })
	let id = [...a.views.keys()][0]!
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	a.conn.send({ type: 'submit', sessionId: id, text: '/auth' })
	await until(() => outputs(b.views.get(id)).length)
	let code = /\b([0-9a-hjkmnp-tv-z]{6})\b/.exec(outputs(a.views.get(id))[0]!)![1]!
	expect(outputs(b.views.get(id))).toEqual(outputs(a.views.get(id)))
	expect(everyFile(home)).not.toContain(code)
	// Gone from what a client opening the session now sees.
	let c = client()
	c.conn.send({ type: 'open', sessionId: id })
	await until(() => c.views.get(id))
	expect(outputs(c.views.get(id))).toEqual([])
	expect(c.views.get(id)!.items.some((i) => i.type === 'command' && i.text === '/auth')).toBe(true)
	expect('token' in webAuth.redeem(code)).toBe(true)
	// Single use.
	expect(webAuth.redeem(code)).toEqual({ refused: 'wrong' })
})

test('/auth revoke ends every web session', async () => {
	let a = client()
	a.conn.send({ type: 'create', cwd: home, model: 'hal/intro' })
	let id = [...a.views.keys()][0]!
	let out = webAuth.redeem(webAuth.issue())
	if (!('token' in out)) throw new Error('code refused')
	expect(webAuth.valid(out.token)).toBe(true)
	a.conn.send({ type: 'submit', sessionId: id, text: '/auth revoke' })
	await until(() => outputs(a.views.get(id)).length)
	expect(webAuth.valid(out.token)).toBe(false)
})

test('codes are 6 Crockford characters, fresh each time, and a token is valid only as issued', () => {
	let codes = new Set(Array.from({ length: 200 }, () => webAuth.issue()))
	expect(codes.size).toBe(200)
	for (let code of codes) expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]{6}$/)
	let out = webAuth.redeem([...codes][0])
	if (!('token' in out)) throw new Error('code refused')
	for (let bad of [out.token.toUpperCase(), out.token.slice(1), `${out.token}0`, undefined, 42, ['x']]) expect(webAuth.valid(bad)).toBe(false)
	for (let bad of [undefined, 42, {}, 'x'.repeat(10_000)]) expect(webAuth.redeem(bad)).toEqual({ refused: 'wrong' })
})

const main = `${import.meta.dir}/../main.ts`
const runAuth = () => Bun.spawn(['bun', main, 'auth'], { env: { ...process.env, HAL_HOME: home }, stdout: 'pipe', stderr: 'pipe' })

test('./run auth prints a code from the running host, or says none is running', async () => {
	let none = runAuth()
	expect(await none.exited).toBe(1)
	expect(await new Response(none.stderr).text()).toContain('no Hal is running')
	expect(await server.serve()).toBe(true)
	let asked = runAuth()
	expect(await asked.exited).toBe(0)
	let code = /\b([0-9a-hjkmnp-tv-z]{6})\b/.exec(await new Response(asked.stdout).text())![1]!
	expect('token' in webAuth.redeem(code)).toBe(true)
})
