// Web endpoint, host end: whichever process is host also serves HTTP on
// 127.0.0.1:web.port() and stops with the host (server.ts starts and
// stops it). A browser logs in with a one-time code (web-auth.ts,
// task 8a) and keeps a session token in an HttpOnly cookie.
//
//   GET  /         the browser client (src/web/, a SolidJS app bundled
//   GET  /<id>     by web.page() with the JSX compiler, which is loaded
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
//                  web.version()) is closed with code 4000: reload.
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
//   Any page or file above asked for without a login gets the gate (the
//   page at that address), which comes back to it once logged in; with
//   ?auth=<code> a file address redeems the code like a page (task e3).

import type { BunPlugin, Server, ServerWebSocket } from 'bun'
import { colors, type Style } from '../common/colors.ts'
import { oklch } from '../common/oklch.ts'
import { session } from '../common/session.ts'
import { settings } from '../common/settings.ts'
import { blobs } from './blobs.ts'
import { diag } from './diag.ts'
import { filePage } from './file-page.ts'
import { host } from './host.ts'
import { webAuth } from './web-auth.ts'
import { webLinks } from './web-links.ts'

const cookieName = 'hal'

type Data = { conn?: ReturnType<typeof host.adapt>; stale?: boolean }
type Socket = ServerWebSocket<Data>

function authorized(req: Request): boolean {
	return webAuth.valid(new Bun.CookieMap(req.headers.get('cookie') ?? '').get(cookieName))
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
function redeem(code: unknown, req: Request): { cookie?: string; refused?: 'wrong' | 'limited' } {
	let out = webAuth.redeem(code)
	if ('refused' in out) return out
	webLinks.used(webAuth.normalize(code as string))
	let hostname = URL.parse(`http://${req.headers.get('host') ?? ''}`)?.hostname
	let local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname ?? '') && req.headers.get('x-forwarded-proto') !== 'https'
	let maxAge = Math.floor(webAuth.tokenMs() / 1000)
	let cookie = new Bun.Cookie(cookieName, out.token, { path: '/', httpOnly: true, secure: !local, sameSite: 'strict', maxAge })
	return { cookie: cookie.serialize() }
}

// The JSX compiler, loaded on first use: nothing else on the host
// path needs it. Missing or broken, it fails the page, not the host.
const compiler = (): Promise<{ transform(source: string, opts: object): { code: string } }> => import('@dom-expressions/compiler')

// A Bun plugin compiling .tsx into Solid's DOM calls.
async function plugin(): Promise<BunPlugin> {
	let { transform } = await web.compiler()
	return {
		name: 'solid',
		setup(build) {
			build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
				contents: transform(await Bun.file(args.path).text(), { filename: args.path, moduleName: '@solidjs/web', generate: 'dom' }).code,
				loader: 'ts',
			}))
		},
	}
}

// The browser client (src/web/): index.html with main.tsx bundled into
// it, built on first request and kept for the life of the server. The
// format is iife: esm output breaks an inline classic script. `version`,
// a hash of the page, is also in it, so a page can tell whether it was
// built from the host's code.
async function build(): Promise<{ html: string; version: string }> {
	let dir = `${import.meta.dir}/../web`
	let plugins = [await web.plugin()]
	let out = await Bun.build({ entrypoints: [`${dir}/main.tsx`], target: 'browser', format: 'iife', minify: true, plugins })
	if (!out.success) throw new AggregateError(out.logs, 'web: bundling src/web/main.tsx failed')
	let js = (await out.outputs[0]!.text()).replaceAll('</script', '<\\/script')
	let html = (await Bun.file(`${dir}/index.html`).text()).replace('/*APP*/', () => js)
	let version = Bun.hash(html).toString(36)
	return { html: html.replace('/*VERSION*/', version), version }
}

// The version of the page this host serves; undefined if it can't build.
async function version(): Promise<string | undefined> {
	web.state.page ??= web.build()
	return web.state.page.then(
		(p) => p.version,
		() => undefined,
	)
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

// The theme as CSS, computed now so overrides show on the next load:
// one class per style (toolBash is .tool-bash) with fg as color, bg as
// background and any other colour as a custom property (--link-bg),
// plus --quiet: the fg's quieter, still readable form (oklch.quiet), for
// secondary text, which never fades by opacity (tasks/README.md). The
// page's is measured on its lightest surface, the button.
function css(): string {
	let rules: string[] = []
	for (let [key, value] of Object.entries(colors)) {
		if (typeof value !== 'function') continue
		let decls = Object.entries(value() as Style).map(([part, c]) => {
			let prop = part === 'fg' ? 'color' : part === 'bg' ? 'background-color' : `--${kebab(part)}`
			return `${prop}: ${oklch.toHex(c)}`
		})
		let style = value() as Style
		let fg = style.fg ?? style.text
		if (fg) decls.push(`--quiet: ${oklch.toHex(oklch.quiet(fg, style.bg ?? style.button ?? colors.screen))}`)
		rules.push(`.${kebab(key)} { ${decls.join('; ')} }`)
	}
	return rules.join('\n')
}

async function page(): Promise<Response> {
	web.state.page ??= web.build()
	let html: string
	try {
		html = (await web.state.page).html
	} catch (e: any) {
		web.state.page = null
		diag.log(`${e?.message ?? e}: ${e?.errors?.join('\n') ?? ''}`)
		return new Response('the web client failed to build; see diag.log\n', { status: 500 })
	}
	html = html.replace('/*COLORS*/', () => web.css()).replace('/*SETTINGS*/', () => settings.forPage())
	return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

// The login gate at a file's address: the page, which shows the gate
// and reloads the address once logged in. Never cached, unlike the file.
async function gate(): Promise<Response> {
	let res = await web.page()
	if (!res.ok) return res
	return new Response(res.body, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

async function login(req: Request): Promise<Response> {
	let code: unknown
	try {
		code = (await req.formData()).get('code')
	} catch {
		return new Response('expected a form with a code field\n', { status: 400 })
	}
	let { cookie, refused } = web.redeem(code, req)
	if (refused === 'limited') return new Response('too many wrong codes; try again in a minute\n', { status: 429 })
	if (!cookie) return new Response('wrong or expired code\n', { status: 401 })
	return new Response(null, { status: 204, headers: { 'set-cookie': cookie } })
}

// A page address with ?auth=<code>: redeemed, then sent to the same
// address without it, logged in if the code was right.
function linkLogin(url: URL, req: Request): Response {
	let { cookie } = web.redeem(url.searchParams.get('auth'), req)
	url.searchParams.delete('auth')
	let headers: Record<string, string> = { location: url.pathname + url.search, 'cache-control': 'no-store' }
	if (cookie) headers['set-cookie'] = cookie
	return new Response(null, { status: 303, headers })
}

function fetch(req: Request, srv: Server<Data>): Response | Promise<Response | undefined> | undefined {
	let url = new URL(req.url)
	let { pathname } = url
	let get = req.method === 'GET'
	let blob = get && (pathname.startsWith('/blob/') || filePage.owns(pathname))
	if (get && url.searchParams.has('auth') && (blob || pathname === '/' || session.isId(pathname.slice(1)))) return web.linkLogin(url, req)
	if (get && (pathname === '/' || session.isId(pathname.slice(1)))) return web.page()
	if (pathname === '/login' && req.method === 'POST') return web.login(req)
	let check = pathname === '/login' && get
	if (!check && !blob && pathname !== '/ws') return new Response('not found\n', { status: 404 })
	// A page asked for without a login gets the gate, which reloads it
	// after the login; the API gets a bare 401.
	if (!web.authorized(req)) return blob ? web.gate() : new Response('log in first\n', { status: 401 })
	if (blob) return web.blob(pathname)
	if (check) return new Response(null, { status: 204 })
	if (!web.sameOrigin(req)) return new Response('wrong origin\n', { status: 403 })
	return web.upgrade(req, srv)
}

// A page built from other code than the host's (a restart onto newer
// code) is told to reload: opened, then closed with code 4000.
async function upgrade(req: Request, srv: Server<Data>): Promise<Response | undefined> {
	let v = new URL(req.url).searchParams.get('v')
	let stale = v !== null && v !== (await web.version())
	if (srv.upgrade(req, { data: { stale } })) return undefined
	return new Response('expected a WebSocket upgrade\n', { status: 400 })
}

// One attachment, by exact session and blob id, or a pasted file's page
// or bytes by exact name; anything else is 404.
function blob(pathname: string): Response {
	if (filePage.owns(pathname)) return filePage.serve(pathname, web.css())
	let m = /^\/blob\/([\w-]+)\/([0-9a-z]{6}|[0-9a-f]{12})$/.exec(pathname)
	let found = m ? blobs.read(m[1]!, m[2]!) : undefined
	if (!found) return new Response('not found\n', { status: 404 })
	let type = found.mediaType === 'text/plain' ? 'text/plain; charset=utf-8' : found.mediaType
	return new Response(new Uint8Array(found.bytes), { headers: { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable' } })
}

const websocket = {
	open(ws: Socket) {
		if (ws.data.stale) return ws.close(4000, 'reload')
		web.state.sockets.add(ws)
		ws.data.conn = host.adapt((message) => ws.send(message))
	},
	message(ws: Socket, message: string | Buffer) {
		ws.data.conn?.receive(String(message))
	},
	close(ws: Socket) {
		web.state.sockets.delete(ws)
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
	web.state.page = null
	web.state.sockets.clear()
	webAuth.close()
	await srv?.stop(true)
}

// /auth revoke: every session token and unused code is void, and every
// open page is closed with code 4001, on which it reloads to the gate.
function revoke(): void {
	webAuth.revoke()
	for (let ws of web.state.sockets) ws.close(4001, 'logged out')
	web.state.sockets.clear()
}

export const web = {
	state: { server: null as Server<Data> | null, page: null as Promise<{ html: string; version: string }> | null, sockets: new Set<Socket>() },
	// config.ason's webPort; overridable from local.ts.
	port: (): number => settings.webPort(),
	authorized,
	sameOrigin,
	redeem,
	linkLogin,
	revoke,
	css,
	compiler,
	plugin,
	build,
	version,
	page,
	gate,
	upgrade,
	login,
	blob,
	fetch,
	start,
	stop,
}
