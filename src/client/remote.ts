// The terminal as a client of a remote host (task tr): `./run -r
// <host>` logs in to the host's web endpoint like a browser (a one-time
// code swapped for a session token, task 8a) and follows it over the
// same WebSocket transport (common/ws-link.ts). The token is a secret:
// it goes only into the saved file (secrets/remote.ason, 0600, kept by
// main.ts) and the Cookie header, never onto the screen or into a log.

import type { LinkState } from '../common/connection.ts'
import type { Event } from '../common/protocol.ts'
import { wsLink, type Socket } from '../common/ws-link.ts'

// What main.ts keeps in secrets/remote.ason: the last host and a token
// per host (origin).
export type Saved = { last: string; tokens: Record<string, string> }

const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

// The origin a typed host names: a hostname with an optional port (https,
// but http for this machine) or an http(s) origin. Anything with a path,
// query or credentials is refused.
function origin(typed: string): string {
	let text = typed.trim()
	let scheme = /^[a-z][\w+.-]*:\/\//i.test(text) ? '' : local.test(text) ? 'http://' : 'https://'
	let url = URL.parse(scheme + text)
	let plain = url && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && !text.endsWith('?') && !text.endsWith('#')
	if (!url || !plain || !['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error(`not a host: ${typed}; use a name like example.com or https://example.com`)
	return url.origin
}

const cookie = (token: string) => `hal=${token}`

class Unavailable extends Error {}

// A request to the host; not reaching it throws, naming it.
async function request(at: string, path: string, init: RequestInit): Promise<Response> {
	try {
		return await remote.fetch(at + path, { ...init, redirect: 'manual' })
	} catch (e: any) {
		throw new Unavailable(`cannot reach ${at}${path}: ${e?.message ?? e}`)
	}
}

// Swaps a one-time code for a token; undefined if the code is wrong or
// used. Other refusals (too many wrong codes) and network errors throw.
async function login(at: string, code: string): Promise<string | undefined> {
	let res = await request(at, '/login', { method: 'POST', body: new URLSearchParams({ code }) })
	if (res.status === 401) return undefined
	if (!res.ok) throw new Error(`${at}: ${(await res.text()).trim() || `HTTP ${res.status}`}`)
	for (let header of res.headers.getSetCookie()) {
		let c = Bun.Cookie.parse(header)
		if (c.name === 'hal' && c.value) return c.value
	}
	throw new Error(`${at} answered the login without a session cookie; is it a Hal host?`)
}

// Whether a Hal answers at `at`, checked before the user is asked for
// anything: its public web manifest names it. Throws, saying why not.
async function probe(at: string): Promise<void> {
	let res = await request(at, '/manifest.webmanifest', {})
	let name = res.ok ? (await res.json().catch(() => null))?.name : undefined
	if (name !== 'Hal') throw new Error(`${at} answers (HTTP ${res.status}) but is not a Hal host`)
}

// Whether the host still takes this token; throws if it can't be asked.
async function valid(at: string, token: string): Promise<boolean> {
	let res = await request(at, '/login', { headers: { cookie: cookie(token) } })
	if (res.status === 204) return true
	if (res.status === 401) return false
	let message = `${at}/login: HTTP ${res.status}\n${await res.text()}`
	throw res.status >= 500 ? new Unavailable(message) : new Error(message)
}

// A logged-in token for `typed` (or the saved last host), asking for
// codes on `ask` until one is right; `saved` is updated for main.ts to
// write. A saved token the host no longer takes is dropped.
async function signIn(typed: string | undefined, saved: Saved, ask: (question: string) => string | null, say: (text: string) => void): Promise<{ origin: string; token: string }> {
	if (!typed && !saved.last) throw new Error('no remembered host; use ./run -r <host>')
	let at = remote.origin(typed || saved.last)
	let token: string | undefined = saved.tokens[at]
	if (token) {
		try {
			if (!(await remote.valid(at, token))) {
				say(`${at} no longer takes the saved login.\n`)
				token = undefined
			}
		} catch (e) {
			if (!(e instanceof Unavailable)) throw e
			// The saved login lets the transport retry without asking for a
			// code during an outage. The host still authenticates every socket.
			say(`${e.message}\nReconnecting with the saved login.\n`)
		}
	}
	if (!token) await remote.probe(at)
	while (!token) {
		let code = ask(`One-time code for ${at} (/auth or hal auth there):`)?.trim()
		if (!code) throw new Error('login cancelled')
		token = await remote.login(at, code)
		if (!token) say('Wrong or expired code.\n')
	}
	saved.last = at
	saved.tokens = { ...saved.tokens, [at]: token }
	return { origin: at, token }
}

// Opens /ws with the token as the cookie and an Origin naming the host,
// as a page of it would send (host/web.ts checks both).
function dial(at: string, token: string): Socket {
	let url = `${at.replace(/^http/, 'ws')}/ws`
	return new WebSocket(url, { headers: { cookie: cookie(token), origin: at, 'user-agent': 'hal-terminal' } } as any) as unknown as Socket
}

// Follows the host until the process ends; `loggedOut` runs when the
// host revokes the token (it then never reconnects by itself).
function start(opts: { origin: string; token: string; onEvent: (event: Event) => void; onState: (state: LinkState) => void; loggedOut: () => void }): void {
	wsLink.start({
		dial: () => remote.dial(opts.origin, opts.token),
		reload: opts.loggedOut,
		authorized: () => remote.valid(opts.origin, opts.token),
		onEvent: opts.onEvent,
		onState: opts.onState,
	})
}

export const remote = {
	fetch: (url: string, init?: RequestInit): Promise<Response> => globalThis.fetch(url, init),
	origin,
	login,
	probe,
	valid,
	signIn,
	dial,
	start,
}
