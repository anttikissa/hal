// Composition root: the one explicit startup path. Other modules do no
// work on import; start() calls their init() functions in order.
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from './client/app.ts'
import { draftFile } from './client/draft-file.ts'
import { link } from './client/link.ts'
import { render } from './client/render.ts'
import { terminal } from './client/terminal.ts'
import { connection, type LinkState } from './common/connection.ts'
import { drafts } from './common/drafts.ts'
import type { Event } from './common/protocol.ts'
import { anthropic } from './host/anthropic.ts'
import { config } from './host/config.ts'
import { diag } from './host/diag.ts'
import { host } from './host/host.ts'
import { openaiCompat } from './host/openai-compat.ts'
import { paths } from './host/paths.ts'
import { server } from './host/server.ts'

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

// Module init() calls go here, in order, once modules have them.
function init(): void {
	paths.init()
	host.init()
	anthropic.init()
	openaiCompat.init()
	// Piped stdin (tests, scripts) has no raw mode and no emergency keys.
	if (terminal.available()) {
		terminal.init()
		// Ctrl-C pauses running turns only if no other Hal process (a peer
		// on the host socket) can carry them on (tasks/j1/states.md).
		terminal.onQuit = () => host.quitting(server.state.sockets.size === 0)
		render.init()
		// Drafts are kept on this machine too, for when the host is gone.
		draftFile.dir = () => join(paths.stateDir(), 'drafts')
		drafts.store = draftFile
		app.init()
	}
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

// Becomes host if nobody is, and then continues every turn the previous
// host left unfinished.
async function becomeHost(): Promise<boolean> {
	if (!(await server.serve())) return false
	host.recover().catch((e) => diag.log(`recover: ${e?.message ?? e}`))
	return true
}

async function start(): Promise<void> {
	// config.ason first, so local.ts sees it and may override settings.*.
	// Warnings about it reach every client connected to this host.
	config.init(() => host.warnAll())
	await main.loadLocal()
	main.init()
	if (!terminal.available()) {
		process.stderr.write('hal2 needs a terminal\n')
		process.exit(1)
	}
	await main.joinHost(
		(event) => app.onEvent(event),
		(state) => app.onState(state),
	)
	connection.send({ type: 'open-newest', cwd: process.cwd() })
}

export const main = { localPath, loadLocal, init, becomeHost, joinHost, start }

// Only ./run starts Hal; importing this file (tests, eval) does nothing.
if (import.meta.main) await main.start()
