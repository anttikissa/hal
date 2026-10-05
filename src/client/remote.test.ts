import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { connection, type LinkState } from '../common/connection.ts'
import type { Event } from '../common/protocol.ts'
import { host } from '../host/host.ts'
import { paths } from '../host/paths.ts'
import { server } from '../host/server.ts'
import { sessions } from '../host/sessions.ts'
import { web } from '../host/web.ts'
import { webAuth } from '../host/web-auth.ts'
import { remote, type Saved } from './remote.ts'

const savedHome = process.env.HAL_HOME
const origPort = web.port
let home = ''

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-remote-`)
	process.env.HAL_HOME = home
	paths.init()
	web.port = () => 0
})

afterEach(async () => {
	connection.stop()
	await server.stop()
	host.reset()
	sessions.closeAll()
	web.port = origPort
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

async function serve(): Promise<string> {
	await server.serve()
	web.start()
	return `http://127.0.0.1:${web.state.server!.port}`
}

async function until(check: () => unknown): Promise<void> {
	for (let i = 0; i < 1000; i++) {
		if (check()) return
		await Bun.sleep(2)
	}
	throw new Error('timed out')
}

test('a typed host becomes an origin: https unless it is this machine; paths and credentials are refused', () => {
	expect(remote.origin('example.com')).toBe('https://example.com')
	expect(remote.origin(' example.com:8443 ')).toBe('https://example.com:8443')
	expect(remote.origin('localhost:9000')).toBe('http://localhost:9000')
	expect(remote.origin('http://example.com/')).toBe('http://example.com')
	for (let bad of ['example.com/x', 'me@example.com', 'example.com?x', 'ftp://example.com', 'wss://example.com', ''])
		expect(() => remote.origin(bad)).toThrow()
})

test('no code is asked before a Hal is known to answer at the host', async () => {
	let other = Bun.serve({ port: 0, fetch: () => new Response('<html>not hal</html>') })
	let asked = 0
	try {
		await expect(remote.signIn(`127.0.0.1:${other.port}`, { last: '', tokens: {} }, () => (asked++, 'x'), () => {})).rejects.toThrow('not a Hal host')
		await expect(remote.signIn('127.0.0.1:1', { last: '', tokens: {} }, () => (asked++, 'x'), () => {})).rejects.toThrow('cannot reach')
	} finally { other.stop(true) }
	expect(asked).toBe(0)
})
test('a wrong code is asked again, a right one is remembered, and a revoked token asks anew', async () => {
	let at = await serve()
	let saved: Saved = { last: '', tokens: {} }
	let codes = ['wrong1', webAuth.issue()]
	let said: string[] = []
	let ask = () => codes.shift() ?? null
	let first = await remote.signIn(at.replace('http://', ''), saved, ask, (t) => said.push(t))
	expect(first.origin).toBe(at)
	expect(said).toEqual(['Wrong or expired code.\n'])
	expect(saved).toEqual({ last: at, tokens: { [at]: first.token } })
	// The token never reaches what the user is shown.
	expect(said.join('')).not.toContain(first.token)

	// ./run -r alone: the saved host and token, no code asked.
	expect(await remote.signIn(undefined, saved, () => null, () => {})).toEqual(first)

	web.revoke()
	await expect(remote.signIn(undefined, saved, () => null, () => {})).rejects.toThrow('login cancelled')
	let again = await remote.signIn(undefined, saved, () => webAuth.issue(), () => {})
	expect(again.token).not.toBe(first.token)
	expect(saved.tokens[at]).toBe(again.token)
})

test('over the WebSocket the terminal gets the remote tabs, its commands are carried out, and revoking logs it out', async () => {
	let at = await serve()
	let id = sessions.create({ cwd: '/tmp' }).id
	let { token } = await remote.signIn(at, { last: '', tokens: {} }, () => webAuth.issue(), () => {})
	let events: Event[] = []
	let states: LinkState[] = []
	let loggedOut = 0
	remote.start({ origin: at, token, onEvent: (e) => events.push(e), onState: (s) => states.push(s), loggedOut: () => loggedOut++ })
	await until(() => states.some((s) => s.type === 'connected'))
	connection.send({ type: 'tab-start' })
	await until(() => events.some((e) => e.type === 'ack'))
	expect(events.find((e) => e.type === 'tabs')).toBeDefined()
	expect(sessions.openIds()).toContain(id)

	web.revoke()
	await until(() => loggedOut > 0)
})

test('a token revoked while away logs out on the refused reconnect instead of retrying forever', async () => {
	let at = await serve()
	let { token } = await remote.signIn(at, { last: '', tokens: {} }, () => webAuth.issue(), () => {})
	web.revoke()
	let loggedOut = 0
	remote.start({ origin: at, token, onEvent: () => {}, onState: () => {}, loggedOut: () => loggedOut++ })
	await until(() => loggedOut > 0)
})

test('saved-login startup retains the token through a gateway failure, but not other HTTP refusals', async () => {
	let original = remote.fetch
	let saved: Saved = { last: 'https://example.com', tokens: { 'https://example.com': 'private-token' } }
	let output: string[] = []
	let requests: string[] = []
	let body = '<html>temporary gateway failure\nupstream unavailable</html>'
	try {
		remote.fetch = async (url) => {
			requests.push(url)
			return new Response(body, { status: 502 })
		}
		expect(await remote.signIn(undefined, saved, () => { throw new Error('must not ask') }, (text) => output.push(text)))
			.toEqual({ origin: saved.last, token: 'private-token' })
		expect(requests).toEqual(['https://example.com/login'])
		expect(output.join('')).toContain('https://example.com/login: HTTP 502')
		expect(output.join('')).toContain(body)
		expect(output.join('')).not.toContain('private-token')
		expect(saved.tokens[saved.last]).toBe('private-token')

		remote.fetch = async () => new Response('rate limited', { status: 429 })
		await expect(remote.signIn(undefined, saved, () => null, () => {})).rejects.toThrow('HTTP 429\nrate limited')
		// A first connection still fails before asking for a code.
		remote.fetch = async () => new Response(body, { status: 502 })
		await expect(remote.signIn(saved.last, { last: '', tokens: {} }, () => { throw new Error('must not ask') }, () => {}))
			.rejects.toThrow('not a Hal host')
	} finally { remote.fetch = original }
})

test('a remote terminal starting while its host is down reconnects when the host returns', async () => {
	let at = await serve()
	let saved: Saved = { last: '', tokens: {} }
	let first = await remote.signIn(at, saved, () => webAuth.issue(), () => {})
	let port = web.state.server!.port!
	await web.stop()
	let output: string[] = []
	let login = await remote.signIn(undefined, saved, () => { throw new Error('must not ask') }, (text) => output.push(text))
	expect(login).toEqual(first)
	expect(output.join('')).toContain(`cannot reach ${at}/login`)
	let states: LinkState[] = []
	let loggedOut = 0
	remote.start({ ...login, onEvent: () => {}, onState: (s) => states.push(s), loggedOut: () => loggedOut++ })
	await until(() => states.some((s) => s.type === 'disconnected'))
	web.port = () => port
	web.start()
	await until(() => states.some((s) => s.type === 'connected'))
	expect(loggedOut).toBe(0)
	expect(saved.tokens[at]).toBe(first.token)
})
