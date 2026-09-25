// Composition root: the one explicit startup path. Other modules do no
// work on import; start() calls their init() functions in order.
import { existsSync } from 'fs'
import { join } from 'path'
import { link, type Role } from './client/link.ts'
import { terminal } from './client/terminal.ts'
import type { Event } from './common/protocol.ts'
import { host } from './host/host.ts'
import { paths } from './host/paths.ts'
import { server } from './host/server.ts'

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
	// Piped stdin (tests, scripts) has no raw mode and no emergency keys.
	if (process.stdin.isTTY) terminal.init()
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

async function start(): Promise<void> {
	await main.loadLocal()
	main.init()
	console.log('hal2')
}

export const main = { localPath, loadLocal, init, joinHost, start }

// Only ./run starts Hal; importing this file (tests, eval) does nothing.
if (import.meta.main) await main.start()
