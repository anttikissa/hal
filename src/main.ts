// Composition root: the one explicit startup path. Other modules do no
// work on import; start() calls their init() functions in order.
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from './client/app.ts'
import { link, type Role } from './client/link.ts'
import { render } from './client/render.ts'
import { terminal } from './client/terminal.ts'
import type { Event } from './common/protocol.ts'
import { anthropic } from './host/anthropic.ts'
import { host } from './host/host.ts'
import { openaiCompat } from './host/openai-compat.ts'
import { paths } from './host/paths.ts'
import { server } from './host/server.ts'
import { sessions } from './host/sessions.ts'

const repoRoot = join(import.meta.dir, '..')

// local.ts lives in the home (the repo root; HAL_HOME only in tests, so
// tests never pick up the user's real overrides).
function localPath(): string {
	return join(process.env.HAL_HOME || repoRoot, 'local.ts')
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
	anthropic.init()
	openaiCompat.init()
	// Piped stdin (tests, scripts) has no raw mode and no emergency keys.
	if (terminal.available()) {
		terminal.init()
		render.init()
		app.init()
	}
}

// Joins this home's host, or becomes it; resolves once connected. Either
// way the terminal client talks to the host through link.send and gets
// events through onEvent; the host process uses the in-memory connection.
function joinHost(onEvent: (event: Event) => void, onRole?: (role: Role | null) => void): Promise<void> {
	return link.start({
		socketPath: server.socketPath(),
		tryHost: () => server.serve(),
		local: (deliver) => host.connect(deliver),
		onEvent,
		onRole,
	})
}

// The session to open at start: the newest readable one on disk, so a
// restart comes back to the same conversation.
function lastSession(): string | undefined {
	let ids = sessions.list().flatMap((s) => (s.meta ? [s.id] : []))
	return ids.sort((a, b) => parseInt(b) - parseInt(a))[0]
}

async function start(): Promise<void> {
	await main.loadLocal()
	main.init()
	if (!terminal.available()) {
		process.stderr.write('hal2 needs a terminal\n')
		process.exit(1)
	}
	await main.joinHost(
		(event) => app.onEvent(event),
		(role) => app.onRole(role),
	)
	let id = main.lastSession()
	link.send(id ? { type: 'open', sessionId: id } : { type: 'create', cwd: process.cwd() })
}

export const main = { localPath, loadLocal, init, joinHost, lastSession, start }

// Only ./run starts Hal; importing this file (tests, eval) does nothing.
if (import.meta.main) await main.start()
