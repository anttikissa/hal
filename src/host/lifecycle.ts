// Host initialization, role policy and supervised lifetime (task fd1).
import { settings } from '../common/settings.ts'
import { anthropic } from './anthropic.ts'
import { config } from './config.ts'
import { restartProcess } from './commands/restart.ts'
import { host } from './host.ts'
import { liveFiles } from './live-file.ts'
import { openai } from './openai.ts'
import { openaiCompat } from './openai-compat.ts'
import { paths } from './paths.ts'
import { promptFiles } from './prompt-files.ts'
import { server } from './server.ts'
import { version } from './version.ts'

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

// Role policy is checked on every join/retry, including print clients. An
// invalid policy must never silently fall back to automatic promotion.
function mayHost(): boolean {
	let data = config.state.data
	let broken = data && liveFiles.brokenError(data)
	if (broken) throw broken
	let mode = settings.state.raw.hostMode
	if (mode !== undefined && mode !== 'auto' && mode !== 'server') throw new Error('config.ason: hostMode must be auto or server')
	return mode !== 'server'
}

// A service supervisor owns restarts; no terminal client or daemon fork.
// Stop preserves unfinished work for the next start, unlike terminal quit.
async function serve(becomeHost: () => Promise<boolean>): Promise<void> {
	process.on('SIGHUP', () => {})
	let stopping = false
	let stop = () => {
		if (stopping) return
		stopping = true
		void server.stop().then(() => process.exit(0), (e) => {
			process.stderr.write(`hal: ${e?.stack ?? e}\n`)
			process.exit(1)
		})
	}
	process.on('SIGTERM', stop)
	process.on('SIGINT', stop)
	process.on('SIGUSR1', () => restartProcess.run())
	if (!(await becomeHost())) {
		process.stderr.write('hal: another host owns this HAL_HOME; stop it before starting hal serve\n')
		process.exit(1)
	}
	version.found = (loaded) => host.announce(loaded)
	void version.init()
}

export const lifecycle = { initHost, mayHost, serve }
