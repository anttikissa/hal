// Web endpoint, host end: whichever process is host also serves HTTP on
// 127.0.0.1:web.port() and stops with the host (server.ts starts and
// stops it). For a trusted test deployment only: one shared password,
// compared as plain text, is also the cookie value.
//
//   GET  /         the browser client (src/web/, a SolidJS app bundled
//                  by web.page() with the JSX compiler, which is loaded
//                  only then: a host that never serves the page never
//                  loads it)
//   POST /login    form field `password`; sets the cookie or answers 401
//   GET  /login    204 if the cookie is good, else 401
//   GET  /ws       WebSocket, one host.adapt() connection (cookie):
//                  each message is one ASON command, each event one
//                  ASON message, like a socket client's lines. The page
//                  picks its session with the open-newest command.

import type { BunPlugin, Server, ServerWebSocket } from 'bun'
import { colors, type Style } from '../common/colors.ts'
import { oklch } from '../common/oklch.ts'
import { settings } from '../common/settings.ts'
import { diag } from './diag.ts'
import { host } from './host.ts'

const cookieName = 'hal'
const tenYears = 10 * 365 * 24 * 3600

type Data = { conn?: ReturnType<typeof host.adapt> }
type Socket = ServerWebSocket<Data>

function authorized(req: Request): boolean {
	return new Bun.CookieMap(req.headers.get('cookie') ?? '').get(cookieName) === web.password()
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
// format is iife: esm output breaks an inline classic script.
async function build(): Promise<string> {
	let dir = `${import.meta.dir}/../web`
	let plugins = [await web.plugin()]
	let out = await Bun.build({ entrypoints: [`${dir}/main.tsx`], target: 'browser', format: 'iife', minify: true, plugins })
	if (!out.success) throw new AggregateError(out.logs, 'web: bundling src/web/main.tsx failed')
	let js = (await out.outputs[0]!.text()).replaceAll('</script', '<\\/script')
	return (await Bun.file(`${dir}/index.html`).text()).replace('/*APP*/', () => js)
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

// The theme as CSS, computed now so overrides show on the next load:
// one class per style (toolBash is .tool-bash) with fg as color, bg as
// background and any other colour as a custom property (--link-bg).
function css(): string {
	let rules: string[] = []
	for (let [key, value] of Object.entries(colors)) {
		if (typeof value !== 'function') continue
		let decls = Object.entries(value() as Style).map(([part, c]) => {
			let prop = part === 'fg' ? 'color' : part === 'bg' ? 'background-color' : `--${kebab(part)}`
			return `${prop}: ${oklch.toHex(c)}`
		})
		rules.push(`.${kebab(key)} { ${decls.join('; ')} }`)
	}
	return rules.join('\n')
}

async function page(): Promise<Response> {
	web.state.page ??= web.build()
	let html: string
	try {
		html = await web.state.page
	} catch (e: any) {
		web.state.page = null
		diag.log(`${e?.message ?? e}: ${e?.errors?.join('\n') ?? ''}`)
		return new Response('the web client failed to build; see diag.log\n', { status: 500 })
	}
	html = html.replace('/*COLORS*/', () => web.css())
	return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
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

function fetch(req: Request, srv: Server<Data>): Response | Promise<Response> | undefined {
	let { pathname } = new URL(req.url)
	if (pathname === '/' && req.method === 'GET') return web.page()
	if (pathname === '/login' && req.method === 'POST') return web.login(req)
	let check = pathname === '/login' && req.method === 'GET'
	if (!check && pathname !== '/ws') return new Response('not found\n', { status: 404 })
	if (!web.authorized(req)) return new Response('log in first\n', { status: 401 })
	if (check) return new Response(null, { status: 204 })
	if (srv.upgrade(req, { data: {} })) return undefined
	return new Response('expected a WebSocket upgrade\n', { status: 400 })
}

const websocket = {
	open(ws: Socket) {
		ws.data.conn = host.adapt((message) => ws.send(message))
	},
	message(ws: Socket, message: string | Buffer) {
		ws.data.conn?.receive(String(message))
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
	web.state.page = null
	await srv?.stop(true)
}

export const web = {
	state: { server: null as Server<Data> | null, page: null as Promise<string> | null },
	// config.ason's webPort and webPassword; overridable from local.ts.
	port: (): number => settings.webPort(),
	password: (): string => settings.webPassword(),
	authorized,
	css,
	compiler,
	plugin,
	build,
	page,
	login,
	fetch,
	start,
	stop,
}
