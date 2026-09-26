// Web endpoint, host end: whichever process is host also serves HTTP on
// 127.0.0.1:web.port() and stops with the host (server.ts starts and
// stops it). For a trusted test deployment only: one shared password,
// compared as plain text, is also the cookie value.
//
//   GET  /         the page (web.page(); the browser client replaces it)
//   POST /login    form field `password`; sets the cookie or answers 401
//   GET  /session  newest session id as text, 204 if none (cookie)
//   GET  /ws       WebSocket, one host.connect() connection (cookie):
//                  each message is one ASON command, each event one
//                  ASON message, like a socket client's lines.

import type { Server, ServerWebSocket } from 'bun'
import { ason } from '../common/ason.ts'
import { diag } from './diag.ts'
import { host, type Connection } from './host.ts'
import { sessions } from './sessions.ts'

const cookieName = 'hal'
const tenYears = 10 * 365 * 24 * 3600

type Socket = ServerWebSocket<{ conn?: Connection }>

function authorized(req: Request): boolean {
	return new Bun.CookieMap(req.headers.get('cookie') ?? '').get(cookieName) === web.password()
}

// Placeholder until the browser client (task dz) replaces this.
function page(): Response {
	return new Response('<!doctype html><title>Hal</title><p>Hal web client goes here.</p>\n', {
		headers: { 'content-type': 'text/html; charset=utf-8' },
	})
}

async function login(req: Request): Promise<Response> {
	let password: unknown
	try {
		password = (await req.formData()).get('password')
	} catch {
		return new Response('expected a form with a password field\n', { status: 400 })
	}
	if (password !== web.password()) return new Response('wrong password\n', { status: 401 })
	let cookie = new Bun.Cookie(cookieName, web.password(), { path: '/', httpOnly: true, sameSite: 'strict', maxAge: tenYears })
	return new Response(null, { status: 204, headers: { 'set-cookie': cookie.serialize() } })
}

function fetch(req: Request, srv: Server<{ conn?: Connection }>): Response | Promise<Response> | undefined {
	let { pathname } = new URL(req.url)
	if (pathname === '/' && req.method === 'GET') return web.page()
	if (pathname === '/login' && req.method === 'POST') return web.login(req)
	if (pathname !== '/session' && pathname !== '/ws') return new Response('not found\n', { status: 404 })
	if (!web.authorized(req)) return new Response('log in first\n', { status: 401 })
	if (pathname === '/session') {
		let id = sessions.newest()
		return id ? new Response(id) : new Response(null, { status: 204 })
	}
	if (srv.upgrade(req, { data: {} })) return undefined
	return new Response('expected a WebSocket upgrade\n', { status: 400 })
}

const websocket = {
	open(ws: Socket) {
		ws.data.conn = host.connect((event) => ws.send(ason.stringify(event, 'short')))
	},
	message(ws: Socket, message: string | Buffer) {
		let command: unknown
		try {
			command = ason.parse(String(message))
		} catch (e: any) {
			ws.send(ason.stringify({ type: 'rejected', command: '', reason: `unreadable message: ${e.message}` }, 'short'))
			return
		}
		ws.data.conn?.send(command)
	},
	close(ws: Socket) {
		ws.data.conn?.close()
	},
}

// Starts listening. A busy port is noted in the diag log, not fatal:
// the host still serves its socket clients. Idempotent.
function start(): void {
	if (web.state.server) return
	try {
		web.state.server = Bun.serve({ hostname: '127.0.0.1', port: web.port(), fetch: web.fetch, websocket })
	} catch (e: any) {
		diag.log(`web: cannot listen on 127.0.0.1:${web.port()}: ${e?.message ?? e}`)
	}
}

// Stops listening and drops every browser connection.
async function stop(): Promise<void> {
	let srv = web.state.server
	web.state.server = null
	await srv?.stop(true)
}

export const web = {
	state: { server: null as Server<{ conn?: Connection }> | null },
	// Config: overridable from local.ts.
	port: (): number => 9002,
	password: (): string => 'hello123',
	authorized,
	page,
	login,
	fetch,
	start,
	stop,
}
