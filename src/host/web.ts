// Web endpoint, host end: whichever process is host also serves HTTP on
// 127.0.0.1:web.port() and stops with the host (server.ts starts and
// stops it). A browser logs in with a one-time code (web-auth.ts,
// task 8a) and keeps a session token in an HttpOnly cookie.
//
//   GET  /         the browser client (src/web/, a SolidJS app bundled
//   GET  /<id>     by webPage.page() with the JSX compiler, which is loaded
//                  only then: a host that never serves the page never
//                  loads it), at / and at any path shaped like a session
//                  id: the page shows that tab (src/web/router.ts).
//                  With ?auth=<code> (a terminal link's hidden target)
//                  the code is redeemed and the answer redirects to the
//                  same address without it, setting the cookie if right.
//   POST /login    form field `code`: sets the cookie, or answers 401
//                  (wrong or used code) or 429 (too many wrong codes)
//   GET  /login    204 if the cookie is good, else 401
//   GET  /ws       WebSocket, one host.adapt() connection (cookie, and
//                  an Origin naming this host): each message is one ASON
//                  command, each event one ASON message, like a socket
//                  client's lines; the tabs come first. A page built
//                  from other code than the host's (`?v=`,
//                  webPage.version()) gets web-update when it opts into
//                  manual updates; legacy pages close with code 4000.
//                  /auth revoke closes every socket with code 4001.
//   GET  /blob/<session>/<blob>  an attachment of that session
//                  (cookie; host/blobs.ts): the id is matched whole,
//                  never used as a path.
//   GET  /image/<name>, /paste/<name>  the page of a pasted image or
//                  long text (cookie; tasks qy, 31, host/file-page.ts):
//                  its content under the paths where it lives, from
//                  /tmp or the session blob a prompt copied it into;
//                  the name must be attachments.fileName.
//   GET  /raw/<name>  that file's bytes (cookie).
//   GET  /demo/<name>  a design demo page (cookie; task 86, demo-page.ts).
//   Any page or file above asked for without a login gets the gate (the
//   page at that address), which comes back to it once logged in; with
//   ?auth=<code> a file address redeems the code like a page (task e3).

import type { Server, ServerWebSocket } from 'bun'
import { ason } from '../common/ason.ts'
import { session } from '../common/session.ts'
import { settings } from '../common/settings.ts'
import { blobs } from './blobs.ts'
import { clients, type ClientInfo } from './clients.ts'
import { diag } from './diag.ts'
import { filePage } from './file-page.ts'
import { changesPage } from './changes-page.ts'
import { contextPage } from './context-page.ts'
import { demoPage } from './demo-page.ts'
import { host } from './host.ts'
import { webAuth } from './web-auth.ts'
import { webDiagnostics } from './web-diagnostics.ts'
import { webLinks } from './web-links.ts'
import { webPage } from './web-page.ts'
import { serverLog } from './server-log.ts'

const cookieName = 'hal'

type Data = {
	loginHash?: string
	conn?: ReturnType<typeof host.adapt>
	stale?: boolean
	manualUpdates?: boolean
	page?: string
	info?: ClientInfo
}
type Socket = ServerWebSocket<Data>

function authorized(req: Request): boolean {
	let h = webAuth.tokenHash(new Bun.CookieMap(req.headers.get('cookie') ?? '').get(cookieName))
	if (!webAuth.validHash(h)) return false
	webAuth.touch(h)
	return true
}

// Whether a WebSocket request comes from a page of this host: its
// Origin names the host the browser asked for (Host, or the proxy's
// X-Forwarded-Host). A browser sets both; another site can't.
function sameOrigin(req: Request): boolean {
	let host = URL.parse(req.headers.get('origin') ?? '')?.host
	return !!host && (host === req.headers.get('host') || host === req.headers.get('x-forwarded-host'))
}

// Swaps a code for a session cookie: Secure unless the browser is on
// this machine over plain HTTP; or why not.
function redeem(code: unknown, req: Request, ip?: string): { cookie?: string; refused?: 'wrong' | 'limited' } {
	let agent = clients.shortAgent(req.headers.get('user-agent') ?? undefined)
	let out = webAuth.redeem(code, agent)
	let address = clients.fromRequest(req, ip).address
	if ('refused' in out) {
		serverLog.log(`web login refused (${out.refused})`, { ...(address && { ip: address }), agent })
		return out
	}
	serverLog.log('web login', { ...(address && { ip: address }), agent })
	webLinks.used(webAuth.normalize(code as string))
	let hostname = URL.parse(`http://${req.headers.get('host') ?? ''}`)?.hostname
	let local =
		['localhost', '127.0.0.1', '[::1]'].includes(hostname ?? '') && req.headers.get('x-forwarded-proto') !== 'https'
	let maxAge = Math.floor(webAuth.tokenMs / 1000)
	let cookie = new Bun.Cookie(cookieName, out.token, {
		path: '/',
		httpOnly: true,
		secure: !local,
		sameSite: 'strict',
		maxAge,
	})
	return { cookie: cookie.serialize() }
}

// The login gate at a file's address: the page, which shows the gate
// and reloads the address once logged in. Never cached, unlike the file.
async function gate(): Promise<Response> {
	let res = await webPage.page()
	if (!res.ok) return res
	return new Response(res.body, {
		status: 401,
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
	})
}

async function login(req: Request, ip?: string): Promise<Response> {
	let code: unknown
	try {
		code = (await req.formData()).get('code')
	} catch {
		return new Response('expected a form with a code field\n', { status: 400 })
	}
	let { cookie, refused } = web.redeem(code, req, ip)
	if (refused === 'limited') return new Response('too many wrong codes; try again in a minute\n', { status: 429 })
	if (!cookie) return new Response('wrong or expired code\n', { status: 401 })
	return new Response(null, { status: 204, headers: { 'set-cookie': cookie } })
}

// A page address with ?auth=<code>: redeemed, then sent to the same
// address without it, logged in if the code was right.
function linkLogin(url: URL, req: Request, ip?: string): Response {
	let { cookie } = web.redeem(url.searchParams.get('auth'), req, ip)
	url.searchParams.delete('auth')
	let headers: Record<string, string> = { location: url.pathname + url.search, 'cache-control': 'no-store' }
	if (cookie) headers['set-cookie'] = cookie
	return new Response(null, { status: 303, headers })
}

function fetch(req: Request, srv: Server<Data>): Response | Promise<Response | undefined> | undefined {
	let url = new URL(req.url)
	let { pathname } = url
	let get = req.method === 'GET'
	let blob =
		get &&
		(pathname.startsWith('/blob/') || filePage.owns(pathname) || contextPage.owns(pathname) || demoPage.owns(pathname))
	let app = get && (pathname === '/' || session.isId(pathname.slice(1)) || changesPage.isApp(pathname))
	if (get && url.searchParams.has('auth') && (blob || app)) return web.linkLogin(url, req, srv.requestIP(req)?.address)
	if (app) return webPage.page()
	let moved = get && changesPage.redirect(url)
	if (moved) return moved
	let changesData = get && changesPage.owns(pathname)
	if (get && pathname === '/budget')
		return new Response(
			'Spawn budget\n\nbN means N spawn slots left in this session. Each subagent spawn, fresh or forked, costs one slot from its owner and every owner ancestor. A zero count anywhere in that chain prevents spawning. Slots are not returned.\n\nSPAWN limit sets the child’s budget, at most its owner’s slots left minus one. Promised slots are not paid upfront: siblings compete for their ancestors’ remaining slots.\n\n/budget shows this session’s count. /budget N sets only this count; ancestors still limit spending. Only the user may change it.\n\nNew sessions and model-opened interactive tabs start with config.ason subagentSlots (default 3); interactive tabs are free. /fork copies the current count and starts an independent tree sharing its origin’s history.\n',
			{ headers: { 'content-type': 'text/plain; charset=utf-8' } },
		)
	if (get && pathname === '/manifest.webmanifest')
		return new Response(
			JSON.stringify({
				name: 'Hal',
				short_name: 'Hal',
				start_url: '/',
				scope: '/',
				display: 'standalone',
				background_color: '#141a26',
				theme_color: '#141a26',
				icons: [
					{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
				],
			}),
			{ headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' } },
		)
	if (get && (pathname === '/icon-192.png' || pathname === '/icon-512.png'))
		return new Response(Bun.file(`${import.meta.dir}/../web${pathname}`), {
			headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
		})
	if (get && /^\/fonts\/IBMPlexMono-(Light|Medium)(Italic)?\.woff2$/.test(pathname))
		return new Response(Bun.file(`${import.meta.dir}/../web${pathname}`), {
			headers: { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=86400' },
		})
	if (get && pathname === '/sw.js')
		return new Response(Bun.file(`${import.meta.dir}/../web/sw.js`), {
			headers: {
				'content-type': 'text/javascript; charset=utf-8',
				'cache-control': 'no-store',
				'service-worker-allowed': '/',
			},
		})
	if (pathname === '/login' && req.method === 'POST') return web.login(req, srv.requestIP(req)?.address)
	if (pathname === '/logout' && req.method === 'POST') {
		if (!web.sameOrigin(req)) return new Response('wrong origin\n', { status: 403 })
		let h = webAuth.tokenHash(new Bun.CookieMap(req.headers.get('cookie') ?? '').get(cookieName))
		if (!webAuth.validHash(h)) return new Response('log in first\n', { status: 401 })
		webAuth.list()
		web.revoke((webAuth.store()[h!] as import('./web-auth.ts').WebLogin).id)
		return new Response(null, {
			status: 303,
			headers: {
				location: '/',
				'set-cookie': 'hal=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
				'cache-control': 'no-store',
			},
		})
	}
	let check = pathname === '/login' && get
	let diagnostic = pathname === '/web-diagnostics' && req.method === 'POST' && settings.webDiagnostics()
	let composerDebug = pathname === '/composer-debug' && req.method === 'POST' && settings.composerDebug()
	if (!check && !blob && !changesData && pathname !== '/ws' && !diagnostic && !composerDebug)
		return new Response('not found\n', { status: 404 })
	// A page asked for without a login gets the gate, which reloads it
	// after the login; the API gets a bare 401.
	if (!web.authorized(req)) return blob ? web.gate() : new Response('log in first\n', { status: 401 })
	if (blob && demoPage.owns(pathname)) return demoPage.serve(pathname, webPage.css())
	if (blob)
		return contextPage.owns(pathname)
			? contextPage.serve(req, webPage.css(), (r) => srv.timeout(r, 0))
			: web.blob(pathname)
	if (changesData) return changesPage.serve(url)
	if (check) return new Response(null, { status: 204 })
	if (!web.sameOrigin(req)) return new Response('wrong origin\n', { status: 403 })
	if (diagnostic) return webDiagnostics.receive(req)
	if (composerDebug) return webDiagnostics.composer(req)
	return web.upgrade(req, srv)
}

// A stale manual-update page stays connected with an update notice.
// Legacy pages still reload when the socket closes with code 4000.
async function upgrade(req: Request, srv: Server<Data>): Promise<Response | undefined> {
	let params = new URL(req.url).searchParams
	let v = params.get('v')
	let manualUpdates = v !== null && params.get('updates') === 'manual'
	let stale = v !== null && v !== (await webPage.version())
	let loginHash = webAuth.tokenHash(new Bun.CookieMap(req.headers.get('cookie') ?? '').get(cookieName))
	if (!webAuth.validHash(loginHash)) return new Response('log in first\n', { status: 401 })
	if (
		srv.upgrade(req, {
			data: {
				loginHash,
				stale,
				manualUpdates,
				page: v ?? undefined,
				info: clients.fromRequest(req, srv.requestIP(req)?.address),
			},
		})
	)
		return undefined
	return new Response('expected a WebSocket upgrade\n', { status: 400 })
}

// One attachment, by exact session and blob id, or a pasted file's page
// or bytes by exact name; anything else is 404.
function blob(pathname: string): Response {
	if (filePage.owns(pathname)) return filePage.serve(pathname, webPage.css())
	let m = /^\/blob\/([\w-]+)\/([0-9a-z]{6}|[0-9a-f]{12})$/.exec(pathname)
	let found = m ? blobs.read(m[1]!, m[2]!) : undefined
	if (!found) return new Response('not found\n', { status: 404 })
	let type = found.mediaType === 'text/plain' ? 'text/plain; charset=utf-8' : found.mediaType
	return new Response(new Uint8Array(found.bytes), {
		headers: {
			'content-type': type,
			'x-content-type-options': 'nosniff',
			'cache-control': 'private, max-age=31536000, immutable',
		},
	})
}

const websocket = {
	open(ws: Socket) {
		if (!webAuth.validHash(ws.data.loginHash)) return ws.close(4001, 'logged out')
		webAuth.touch(ws.data.loginHash)
		if (ws.data.stale && !ws.data.manualUpdates) return ws.close(4000, 'reload')
		if (ws.data.stale) ws.send(ason.stringify({ type: 'web-update' }, 'short'))
		web.state.sockets.add(ws)
		ws.data.conn = host.adapt((message) => ws.send(message), ws.data.info)
	},
	message(ws: Socket, message: string | Buffer) {
		if (!webAuth.validHash(ws.data.loginHash)) return ws.close(4001, 'logged out')
		webAuth.touch(ws.data.loginHash)
		ws.data.conn?.receive(String(message))
	},
	close(ws: Socket) {
		web.state.sockets.delete(ws)
		ws.data.conn?.close()
	},
}
// Try the preferred port and the next free port through 9100. Other
// failures (and an exhausted range) leave socket clients available.
// `hal serve --port` (web.state.fixedPort) tries only that port.
function start(): void {
	if (web.state.server) return
	let preferred = web.state.fixedPort ?? web.port()
	let last = web.state.fixedPort ?? Math.max(preferred, 9100)
	for (let port = preferred; port <= last; port++) {
		try {
			web.state.server = Bun.serve({ hostname: '127.0.0.1', port, fetch: web.fetch, websocket })
			webPage.state.watcher = webPage.watchSource()
			settings.state.listeningPort = web.state.server.port
			webLinks.moved()
			let url = settings.value('webUrl')
			serverLog.log(`web on http://127.0.0.1:${port}/${url ? ` - public ${url}` : ''} ${serverLog.ms()}`)
			return
		} catch (e: any) {
			if (e?.code === 'EADDRINUSE' && port < last) continue
			web.state.error = `cannot listen on 127.0.0.1:${port}: ${e?.message ?? e}`
			diag.log(`web: ${web.state.error}`)
			serverLog.log(`web: ${web.state.error}`)
			return
		}
	}
}

// Stops listening and drops every browser connection.
async function stop(): Promise<void> {
	let srv = web.state.server
	web.state.server = null
	webPage.state.page = null
	webPage.state.watcher?.close()
	webPage.state.watcher = null
	settings.state.listeningPort = undefined
	web.state.sockets.clear()
	webAuth.close()
	webDiagnostics.reset()
	await srv?.stop(true)
}

// /auth revoke: every session token and unused code is void, and every
// open page is closed with code 4001, on which it reloads to the gate.
function revoke(id = 'all'): number {
	let hashes = webAuth.revoke(id)
	for (let ws of web.state.sockets)
		if (hashes.includes(ws.data.loginHash!)) {
			ws.data.conn?.close()
			ws.close(4001, 'logged out')
			web.state.sockets.delete(ws)
		}
	contextPage.closeAll()
	return hashes.length
}

export const web = {
	state: {
		server: null as Server<Data> | null,
		sockets: new Set<Socket>(),
		fixedPort: undefined as number | undefined,
		error: undefined as string | undefined,
	},
	// config.ason's webPort; overridable from local.ts.
	port: (): number => settings.webPort(),
	authorized,
	sameOrigin,
	redeem,
	linkLogin,
	revoke,
	gate,
	upgrade,
	login,
	blob,
	fetch,
	start,
	stop,
}
