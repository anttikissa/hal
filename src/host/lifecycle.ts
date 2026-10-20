// Brings up a process that may host Hal: initialization, the rules for
// which process becomes host, and its supervised lifetime (task fd1).
import { config } from './config.ts'
import { handover, restartProcess } from './commands/restart.ts'
import type { Conn } from '../common/connection.ts'
import type { Event } from '../common/protocol.ts'
import { host } from './host.ts'
import { liveFiles } from './live-file.ts'
import { providers } from './providers.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'
import { serverLog } from './server-log.ts'
import { version } from './version.ts'

// What any process that may host needs, terminal or not.
function initHost(): void {
	paths.init()
	host.init()
	providers.init()
}

// Checked on every join/retry, including print clients: a broken
// config.ason refuses promotion, and a peer that just handed the home to
// hal serve does not take it back.
function mayHost(): boolean {
	let data = config.state.data
	let broken = data && liveFiles.brokenError(data)
	if (broken) throw broken
	return !handover.pending()
}

// A service supervisor owns restarts; no terminal client or daemon fork.
// Stop preserves unfinished work for the next start, unlike terminal quit.
// `dial`: the host socket's client (client/link.ts), to ask for handover.
async function serve(
	becomeHost: () => Promise<boolean>,
	dial: (path: string, on: { event(event: Event): void; dropped(): void }) => Promise<Conn | null>,
): Promise<void> {
	process.on('SIGHUP', () => {})
	let stopping = false
	let stop = (signal: string) => {
		if (stopping) return
		stopping = true
		serverLog.log(`stopping (${signal})`)
		void server.stop().then(
			() => process.exit(0),
			(e) => {
				process.stderr.write(`hal: ${e?.stack ?? e}\n`)
				process.exit(1)
			},
		)
	}
	process.on('SIGTERM', () => stop('SIGTERM'))
	process.on('SIGINT', () => stop('SIGINT'))
	process.on('SIGUSR1', () => (serverLog.log('restarting (SIGUSR1)'), restartProcess.run()))
	if (!(await becomeHost())) {
		// A peer host hands over; another hal serve refuses, and the first prevails.
		let conn = await dial(server.socketPath(), {
			event: (e) =>
				e.type === 'rejected' &&
				e.command === 'handover' &&
				(process.stderr.write(`hal: ${e.reason}\n`), process.exit(1)),
			dropped: () => {},
		})
		conn?.send({ type: 'handover' })
		serverLog.log('asked the host to hand over')
		while (!(await becomeHost())) await Bun.sleep(50)
		conn?.close()
	}
	handover.done()
	serverLog.log(`listening on ${server.socketPath()} ${serverLog.ms()}`)
	version.found = (loaded) => host.announce(loaded)
	void version.init()
}

export const lifecycle = { initHost, mayHost, serve }
