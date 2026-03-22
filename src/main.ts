import { perf } from './perf.ts'
perf.mark('first-code')

import { ensureStateDir } from './state.ts'
import {
	claimHost,
	readHostLock,
	releaseHost,
	appendEvent,
	tailEvents,
} from './ipc.ts'
import { startRuntime } from './server/runtime.ts'
import { startCli, addLocalBlock, setRole } from './client/cli.ts'

ensureStateDir()
perf.mark('state-ready')

let isHost = await claimHost()
const lock = readHostLock()
let serverPid = isHost ? process.pid : (lock?.pid ?? null)
perf.mark('host-election')

setRole(isHost ? 'server' : 'client')
if (isHost) {
	appendEvent({
		type: 'runtime-start',
		pid: process.pid,
		startedAt: new Date().toISOString(),
	})
	addLocalBlock(`Server started (pid ${process.pid}) [${perf.elapsed()}ms]`)
} else {
	addLocalBlock(`Joined server (pid ${serverPid}) [${perf.elapsed()}ms]`)
}

const ac = new AbortController()

function cleanup() {
	ac.abort()
	if (isHost) {
		appendEvent({ type: 'host-released' })
		releaseHost()
	}
	perf.stop()
}

process.on('exit', cleanup)
process.on('SIGTERM', () => {
	cleanup()
	process.exit(0)
})

if (isHost) {
	startRuntime(ac.signal)
} else {
	// Client: watch for host-released event, promote immediately
	// Fallback: poll server PID every 3s in case of crash
	let promoting = false

	async function tryPromote() {
		if (promoting || isHost) return
		promoting = true
		try {
			if (await claimHost()) {
				isHost = true
				serverPid = process.pid
				setRole('server')
				addLocalBlock(`Promoted to server (pid ${process.pid})`)
				startRuntime(ac.signal)
			}
		} finally {
			promoting = false
		}
	}

	// Fast path: host announces it's quitting
	void (async () => {
		for await (const event of tailEvents(ac.signal)) {
			if (event.type === 'host-released') {
				tryPromote()
			}
		}
	})()

	// Slow fallback: poll for crash (when server dies without sending host-released)
	// process.kill(pid, 0) doesn't kill — signal 0 just checks if the pid exists.
	const pollTimer = setInterval(() => {
		if (isHost || promoting) return
		if (serverPid !== null) {
			try {
				process.kill(serverPid, 0)
			} catch {
				serverPid = null
				tryPromote()
			}
		}
	}, 1000)

	ac.signal.addEventListener('abort', () => clearInterval(pollTimer))
}

perf.setSink((lines) => {
	// addLocalBlock(lines.join('\n'))
})

perf.mark('cli-start')
startCli(ac.signal)
