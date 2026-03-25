import { perf } from './perf.ts'
perf.mark('First line of code executed')

import { ensureStateDir } from './state.ts'
import { ipc } from './ipc.ts'
import { runtime } from './server/runtime.ts'
import { cli } from './client/cli.ts'
import { client } from './client.ts'
import { isPidAlive } from './utils/is-pid-alive.ts'
import { log } from './utils/log.ts'
import './config.ts' // load config.ason overrides, watch for changes

ensureStateDir()
perf.mark('State directories exist')

let isHost = await ipc.claimHost()
const lock = ipc.readHostLock()
let serverPid = isHost ? process.pid : (lock?.pid ?? null)
perf.mark(`Host status established (I am ${isHost ? 'host' : 'client'}, server pid ${serverPid})`)
log.info('Startup', { isHost, serverPid, pid: process.pid })

client.state.role = isHost ? 'server' : 'client'
if (isHost) {
	ipc.appendEvent({
		type: 'runtime-start',
		pid: process.pid,
		startedAt: new Date().toISOString(),
	})
	client.addEntry(`Server started (pid ${process.pid}) [${perf.elapsed()}ms]`)
} else {
	client.addEntry(`Joined server (pid ${serverPid}) [${perf.elapsed()}ms]`)
}

const ac = new AbortController()

function cleanup() {
	ac.abort()
	if (isHost) {
		ipc.appendEvent({ type: 'host-released' })
		ipc.releaseHost()
	}
	perf.stop()
}

process.on('exit', cleanup)
process.on('SIGTERM', () => {
	cleanup()
	process.exit(0)
})

if (isHost) {
	runtime.startRuntime(ac.signal)
} else {
	let promoting = false

	async function tryPromote() {
		if (promoting || isHost) return
		promoting = true
		try {
			if (await ipc.promote()) {
				isHost = true
				serverPid = process.pid
				client.state.role = 'server'
				client.addEntry(`Promoted to server (pid ${process.pid})`)
				runtime.startRuntime(ac.signal)
			}
		} finally {
			promoting = false
		}
	}

	void (async () => {
		for await (const event of ipc.tailEvents(ac.signal)) {
			if (event.type === 'host-released') tryPromote()
		}
	})()

	// Slow fallback: poll for crash (server dies without sending host-released).
	// isPidAlive uses signal 0 to check without killing — see is-pid-alive.ts.
	const pollTimer = setInterval(() => {
		if (isHost || promoting) return
		if (serverPid !== null && !isPidAlive(serverPid)) {
			log.info('Server pid died, promoting', { serverPid })
			serverPid = null
			tryPromote()
		}
	}, 1000)
	ac.signal.addEventListener('abort', () => clearInterval(pollTimer))
}

perf.setSink((lines) => {
	for (const line of lines) client.addEntry(line)
})
cli.startCli(ac.signal)
