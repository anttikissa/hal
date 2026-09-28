// Composition root: the one explicit startup path. Other modules do no
// work on import; start() calls their init() functions in order.
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from './client/app.ts'
import { draftFile } from './client/draft-file.ts'
import { link } from './client/link.ts'
import { render } from './client/render.ts'
import { terminal } from './client/terminal.ts'
import { versions } from './client/versions.ts'
import type { LinkState } from './common/connection.ts'
import { drafts } from './common/drafts.ts'
import { perf } from './common/perf.ts'
import { protocol, type Event, type Tab } from './common/protocol.ts'
import { settings } from './common/settings.ts'
import { anthropic } from './host/anthropic.ts'
import { config } from './host/config.ts'
import { diag } from './host/diag.ts'
import { host } from './host/host.ts'
import { jobs } from './host/jobs.ts'
import { models } from './host/models.ts'
import { modelsDev } from './host/models-dev.ts'
import { sessions } from './host/sessions.ts'
import { turns } from './host/turns.ts'
import { version } from './host/version.ts'
import { openai } from './host/openai.ts'
import { openaiCompat } from './host/openai-compat.ts'
import { paths } from './host/paths.ts'
import { server } from './host/server.ts'
import { web } from './host/web.ts'
import { webAuth } from './host/web-auth.ts'

// local.ts lives in the home, so tests (temp home) never pick up the
// user's real overrides.
function localPath(): string {
	return join(paths.home(), 'local.ts')
}

// Imports the optional, gitignored local.ts, which replaces functions on
// module objects. Missing is normal; a broken one throws.
async function loadLocal(): Promise<void> {
	let path = main.localPath()
	if (existsSync(path)) await import(path)
}

// A restart comes back to the tab it left: ./run gives every start of
// one run the same file (HAL_TAB_FILE), holding the tab shown and its
// cwd. A fresh ./run starts empty, so it goes to its cwd's tab.
function lastTab(): { last?: string; cwd?: string } {
	try {
		let [last, cwd] = readFileSync(process.env.HAL_TAB_FILE ?? '', 'utf8').split('\n')
		return last && cwd ? { last, cwd } : {}
	} catch {
		return {}
	}
}

function keepTab(tab: Tab): void {
	let file = process.env.HAL_TAB_FILE
	let text = `${tab.id}\n${tab.cwd}`
	if (!file || main.state.kept === text) return
	main.state.kept = text
	try {
		writeFileSync(file, text)
	} catch {}
}

// Module init() calls go here, in order, once modules have them.
function init(): void {
	paths.init()
	host.init()
	anthropic.init()
	openai.init()
	openaiCompat.init()
	// Piped stdin (tests, scripts) has no raw mode and no emergency keys.
	if (terminal.available()) {
		terminal.init()
		// Ctrl-C pauses running turns only if no other Hal process (a peer
		// on the host socket) can carry them on (tasks/j1/states.md).
		terminal.onQuit = () => host.quitting(server.state.sockets.size === 0)
		render.init()
		render.painted = (view) => {
			if (main.state.shown) return
			perf.mark('frame', view.transcript ? view.transcript.meta.id : 'no tab yet')
			if (view.transcript) main.shown()
		}
		// Drafts are kept on this machine too, for when the host is gone.
		draftFile.dir = () => join(paths.stateDir(), 'drafts')
		drafts.store = draftFile
		app.state.start = { cwd: process.cwd(), ...main.lastTab() }
		app.focused = (tab) => main.keepTab(tab)
		app.init()
		// Which code this process runs (task n1), found after the first
		// frame; the host tells its clients, a new commit offers ctrl-r.
		version.found = (loaded) => {
			versions.state.own = loaded
			host.announce(loaded)
			app.show()
		}
		version.changed = () => ((versions.state.newCode = true), app.show())
		main.later(() => void version.init())
	}
}

// Events from the host for the terminal: the host's version is kept
// for the notice (client/versions.ts), the rest go to the app.
function onEvent(event: Event): void {
	if (event.type !== 'version') return app.onEvent(event)
	versions.state.host = event.version
	app.show()
}

// Joins this home's host, or becomes it; resolves once connected. Either
// way the terminal client talks to the host through connection.send and
// gets events through onEvent; the host process uses the in-memory
// connection.
function joinHost(onEvent: (event: Event) => void, onState?: (state: LinkState) => void): Promise<void> {
	let opts: Parameters<typeof link.start>[0] = {
		socketPath: server.socketPath(),
		tryHost: () => main.becomeHost(),
		local: (deliver) => host.connect(deliver),
		onEvent,
	}
	if (onState) opts.onState = onState
	return link.start(opts)
}

// Becomes host if nobody is. Then, once the first frame is up, serves
// the web and continues every turn the previous host left unfinished.
async function becomeHost(): Promise<boolean> {
	if (!(await server.serve())) return false
	perf.mark('host')
	main.later(() => {
		web.start()
		if (web.state.server && web.state.server.port !== settings.webPort() && terminal.available()) {
			app.state.notice = `Web is on port ${web.state.server.port} (preferred ${settings.webPort()} is busy)`
			app.show()
		}
		turns.recover().catch((e) => diag.log(`recover: ${e?.message ?? e}`))
		jobs.lost().catch((e) => diag.log(`lost jobs: ${e?.message ?? e}`))
		void main.refreshModels()
	})
	return true
}

// Refreshes the models.dev cache (task qq). The user hears of it only
// if a model in use (the default or an open session's) has vanished.
async function refreshModels(): Promise<void> {
	let picked = [settings.model(), ...sessions.openIds().map((id) => sessions.open(id).model)]
	let gone = await modelsDev.refresh([...new Set(picked)])
	let names = models.names([...new Set(picked)])
	if (Object.keys(names).length) for (let client of host.state.clients) client.deliver({ type: 'model-names', names })
	if (!gone.length) return
	let text = `models.dev no longer lists ${gone.join(', ')}`
	for (let client of host.state.clients) client.deliver({ type: 'warning', text })
}

// Runs `work` once the first frame showing a tab is painted (at once
// if it was), so startup draws before anything it does not show. A
// frame that never comes (the tab won't open) holds it for laterMs.
function later(work: () => void): void {
	let st = main.state
	if (st.shown) return void setTimeout(work)
	st.later.push(work)
	st.fallback ??= setTimeout(() => main.shown(), main.laterMs())
}

// The first tab is on screen: the work held for it runs, one task each.
function shown(): void {
	let st = main.state
	if (st.shown) return
	st.shown = true
	perf.mark('shown')
	if (st.fallback) clearTimeout(st.fallback)
	for (let work of st.later.splice(0)) setTimeout(work)
}

// `./run auth`: asks this home's running host for a one-time web login
// code (host/web-auth.ts) and prints it. It never becomes host itself:
// a code from a process about to exit would log nobody in.
async function auth(): Promise<number> {
	let answer = await new Promise<{ code?: string; error?: string }>((resolve) => {
		let timer = setTimeout(() => resolve({ error: 'the host did not answer' }), main.authWaitMs())
		let done = (out: { code?: string; error?: string }) => {
			clearTimeout(timer)
			resolve(out)
		}
		void link
			.dial(server.socketPath(), {
				event: (e) => {
					if (protocol.invalidEvent(e)) return
					if (e.type === 'auth') done({ code: e.code })
					else if (e.type === 'rejected' && e.command === 'auth') done({ error: `the host refused: ${e.reason}` })
				},
				dropped: () => done({ error: 'the host went away' }),
			})
			.then((conn) => {
				if (!conn) return done({ error: `no Hal is running in ${paths.display(paths.home())}; start it with ./run` })
				conn.send({ type: 'auth' })
			})
	})
	if (answer.code === undefined) {
		process.stderr.write(`hal2: ${answer.error}\n`)
		return 1
	}
	process.stdout.write(`web login code: ${answer.code} (one login, ${Math.round(webAuth.codeMs() / 60_000)} minutes)\n`)
	return 0
}

async function start(): Promise<void> {
	perf.state.epoch = Number(process.env.HAL_STARTUP_TIMESTAMP) || perf.state.epoch
	perf.mark('imported')
	// A home too deep for a Unix socket can neither host nor join.
	let problem = server.pathProblem()
	if (problem) {
		process.stderr.write(`hal2: ${problem}\n`)
		process.exit(1)
	}
	if (process.argv[2] === 'auth') process.exit(await main.auth())
	// config.ason first, so local.ts sees it and may override settings.*.
	// Warnings about it reach every client connected to this host.
	config.init(() => host.warnAll())
	await main.loadLocal()
	perf.mark('local.ts')
	main.init()
	perf.mark('init')
	if (!terminal.available()) {
		process.stderr.write('hal2 needs a terminal\n')
		process.exit(1)
	}
	await main.joinHost(
		(event) => main.onEvent(event),
		(state) => app.onState(state),
	)
	perf.mark('joined')
}

export const main = {
	state: { kept: '', shown: false, later: [] as (() => void)[], fallback: undefined as Timer | undefined },
	laterMs: () => 1000,
	authWaitMs: () => 5000,
	lastTab,
	keepTab,
	localPath,
	loadLocal,
	init,
	onEvent,
	becomeHost,
	refreshModels,
	later,
	shown,
	joinHost,
	auth,
	start,
}

// Only ./run starts Hal; importing this file (tests, eval) does nothing.
if (import.meta.main) await main.start()
