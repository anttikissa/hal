// Composition root: the one explicit startup path. Other modules do no
// work on import; start() calls their init() functions in order.
import { existsSync } from 'fs'
import { join } from 'path'
import { terminal } from './client/terminal.ts'
import { paths } from './host/paths.ts'

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

async function start(): Promise<void> {
	await main.loadLocal()
	main.init()
	console.log('hal2')
}

export const main = { localPath, loadLocal, init, start }

// Only ./run starts Hal; importing this file (tests, eval) does nothing.
if (import.meta.main) await main.start()
