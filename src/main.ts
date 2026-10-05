// Composition root: the one explicit startup path. Other modules do no
// work on import; start() calls their init() functions in order.
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { args, type Args } from './client/args.ts'
import { app } from './client/app.ts'
import { command as restart } from './client/commands/restart.ts'
import { appView } from './client/app-view.ts'
import { draftFile } from './client/draft-file.ts'
import { link } from './client/link.ts'
import { print } from './client/print.ts'
import { remote as remoteClient, type Saved } from './client/remote.ts'
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
import { find } from './host/find.ts'
import { host } from './host/host.ts'
import { promptFiles } from './host/prompt-files.ts'
import { restartGuard, restartProcess } from './host/commands/restart.ts'
import { restartNote } from './host/restart-note.ts'
import { jobs } from './host/jobs.ts'
import { liveFiles } from './host/live-file.ts'
import { models } from './host/models.ts'
import { modelsDev } from './host/models-dev.ts'
import { sessions } from './host/sessions.ts'
import { turns } from './host/turns.ts'
import { version } from './host/version.ts'
import { openai } from './host/openai.ts'
import { openaiCompat } from './host/openai-compat.ts'
import { paths } from './host/paths.ts'
import { secrets } from './host/secrets.ts'
import { plugins } from './host/plugins.ts'
import { server } from './host/server.ts'
import { slash } from './host/slash.ts'
import { tabs } from './host/tabs.ts'
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

// Loads and follows plugins/*.ts (task an), after local.ts. A failure
// goes to stderr and, on the host, to every open session and client.
async function loadPlugins(): Promise<void> {
	plugins.report = (text) => {
		process.stderr.write(`${text}\n`)
		for (let id of sessions.openIds()) slash.output(id, text, true)
		for (let client of host.state.clients) client.deliver({ type: 'warning', text })
	}
	await plugins.init()
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

// What any process that may host needs, terminal or not.
function initHost(): void {
	paths.init()
	host.init()
	anthropic.init()
	openai.init()
	openaiCompat.init()
	// Checks only while this process hosts: a peer has no clients.
	promptFiles.start(host.state.clients)
}

// Module init() calls go here, in order, once modules have them.
function init(): void {
	main.initHost()
	// Piped stdin (tests, scripts) has no raw mode and no emergency keys.
	if (!terminal.available()) return
	main.initTerminal()
	// Ctrl-C pauses running turns only if no other Hal process (a peer
	// on the host socket) can carry them on (tasks/j1/states.md).
	terminal.onQuit = () => host.quitting(server.state.sockets.size === 0)
	let exit = terminal.restart
	let restartNow = (): void => {
		if (server.state.listener) {
			let shown = main.state.kept.split('\n')[0], on = ''
			try { if (shown) on = ` on ${tabs.label(shown)}` } catch {}
			restartNote.write(`Ctrl-R in the terminal${on}`)
		}
		exit()
	}
	restartProcess.run = restartNow
	terminal.restart = () => restart.ask({ scope: 'local', calls: restartGuard.flagged() }, app.open, restartNow)
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

// The terminal client, for this home's host or (`remote`, an origin;
// task tr) another machine's, whose drafts are kept apart and where
// this machine's cwd means nothing.
function initTerminal(remote?: string): void {
	terminal.init()
	render.init()
	render.state.gap = true
	render.painted = (view) => {
		if (main.state.shown) return
		perf.mark('frame', view.transcript ? view.transcript.meta.id : 'no tab yet')
		if (view.transcript) main.shown()
	}
	// Drafts are kept on this machine too, for when the host is gone.
	let dir = remote ? join(paths.stateDir(), 'remote', new URL(remote).host) : paths.stateDir()
	draftFile.dir = () => join(dir, 'drafts')
	drafts.store = draftFile
	app.state.start = { ...(remote ? {} : { cwd: process.cwd() }), ...main.lastTab() }
	if (remote) appView.state.remote = new URL(remote).host
	app.focused = (tab) => main.keepTab(tab)
	app.init()
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
	// Who restarted Hal (task 2e): every client now, and those joining within a minute.
	let restarted = restartNote.take()
	if (restarted) {
		for (let client of host.state.clients) client.deliver({ type: 'warning', text: restarted })
		let warn = host.warn
		host.warn = (client) => {
			warn(client)
			let text = restartNote.pending()
			if (text) client.deliver({ type: 'warning', text })
		}
	}
	main.later(() => {
		find.init()
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
// Also lists a ChatGPT login's models now, so the first picker shows
// them rather than models.dev's API-only ones (task q7).
async function refreshModels(): Promise<void> {
	void models.fetchList('openai').catch((e) => diag.log(`models of openai: ${e}`))
	let picked = [settings.model(), ...sessions.openIds().map((id) => sessions.open(id).model)]
	let gone = await modelsDev.refresh([...new Set(picked)])
	let names = models.nameEvent([...new Set(picked)])
	if (names) for (let client of host.state.clients) client.deliver(names)
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
	st.fallback ??= setTimeout(() => main.shown(), main.laterMs)
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
		let timer = setTimeout(() => resolve({ error: 'the host did not answer' }), main.authWaitMs)
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
		process.stderr.write(`hal: ${answer.error}\n`)
		return 1
	}
	process.stdout.write(`${webAuth.message(answer.code)}\n`)
	return 0
}

// `./run -r [host]` (task tr): the terminal follows a remote host over
// its web endpoint, logging in with a one-time code the first time; the
// host and its token are kept in secrets/remote.ason (0600).
async function remote(typed: string | undefined): Promise<void> {
	paths.init()
	secrets.migrate(['state/remote.ason'])
	let saved = secrets.file<Saved>(join(paths.secretsDir(), 'remote.ason'), { last: '', tokens: {} }, { watch: false })
	let origin: string
	let token: string
	try {
		;({ origin, token } = await remoteClient.signIn(typed, saved, (q) => prompt(q), (text) => process.stderr.write(text)))
	} catch (e: any) {
		process.stderr.write(`hal: ${e?.message ?? e}\n`)
		process.exit(1)
	}
	liveFiles.save(saved)
	process.stderr.write(`Connecting to ${origin}…\n`)
	main.initTerminal(origin)
	remoteClient.start({
		origin,
		token,
		onEvent: (event) => main.onEvent(event),
		onState: (state) => app.onState(state),
		// Revoked: forget the token and say how to log in again.
		loggedOut: () => {
			let { [origin]: _, ...rest } = saved.tokens
			saved.tokens = rest
			liveFiles.save(saved)
			terminal.leave()
			process.stderr.write(`hal: ${origin} logged this terminal out; run ./run -r again to log in\n`)
			terminal.state.io!.exit(1)
		},
	})
}

// `hal -p` (task gw): joins the host, or hosts without the web or
// recovery while it runs, and exits with the turn's outcome.
async function printMode(job: Extract<Args, { kind: 'print' }>): Promise<void> {
	let cwd = resolve(job.dir ?? process.cwd())
	if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
		process.stderr.write(`hal: ${cwd} is not a directory\n`)
		process.exit(2)
	}
	main.initHost()
	let run = print.run({ prompt: job.prompt, cwd, ...(job.model && { model: job.model }) }, { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) })
	await link.start({ socketPath: server.socketPath(), tryHost: () => server.serve(), local: (deliver) => host.connect(deliver), onEvent: run.onEvent })
	run.begin()
	process.exit(await run.done)
}

async function start(): Promise<void> {
	// Checked before anything else, so a mistyped option starts nothing.
	let parsed = args.parse(process.argv.slice(2))
	if (parsed.kind === 'help') process.exit((process.stdout.write(args.usage()), 0))
	// The release check loads only here; the checkout is this file's (task jjr).
	if (parsed.kind === 'version') process.exit((process.stdout.write(await (await import('./host/release.ts')).release.cli()), 0))
	if (parsed.kind === 'error') process.exit((process.stderr.write(`hal: ${parsed.message}\n\n${args.usage()}`), 2))
	perf.state.epoch = Number(process.env.HAL_STARTUP_TIMESTAMP) || perf.state.epoch
	perf.mark('imported')
	// scripts/perf sets HAL_STALLS: every event-loop block over 10 ms is
	// appended there as "pid wall-clock-ms length-ms" (task 7j).
	let stalls = process.env.HAL_STALLS
	if (stalls) perf.watch((ms) => appendFileSync(stalls, `${process.pid} ${Date.now()} ${ms.toFixed(0)}\n`))
	// A home too deep for a Unix socket can neither host nor join.
	let problem = server.pathProblem()
	if (problem) {
		process.stderr.write(`hal: ${problem}\n`)
		process.exit(1)
	}
	if (parsed.kind === 'auth') process.exit(await main.auth())
	// config.ason first, so local.ts sees it and may override settings.*.
	// Warnings about it reach every client connected to this host.
	config.init(() => host.warnAll())
	await main.loadLocal()
	perf.mark('local.ts')
	await main.loadPlugins()
	perf.mark('plugins')
	if (parsed.kind === 'print') return main.printMode(parsed)
	if (parsed.kind === 'remote') {
		if (!terminal.available()) {
			process.stderr.write('hal needs a terminal\n')
			process.exit(1)
		}
		return main.remote(parsed.host)
	}
	main.init()
	perf.mark('init')
	if (!terminal.available()) {
		process.stderr.write('hal needs a terminal\n')
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
	laterMs: 1000,
	authWaitMs: 5000,
	lastTab,
	keepTab,
	localPath,
	loadLocal,
	loadPlugins,
	initHost,
	init,
	initTerminal,
	onEvent,
	becomeHost,
	refreshModels,
	later,
	shown,
	joinHost,
	auth,
	remote,
	printMode,
	start,
}

// Only ./run starts Hal; importing this file (tests, eval) does nothing.
if (import.meta.main) await main.start()
