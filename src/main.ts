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
import { startCli } from './client/cli.ts'

ensureStateDir()
perf.mark('state-ready')

let isHost = await claimHost()
const lock = readHostLock()
let serverPid = isHost ? process.pid : (lock?.pid ?? null)
perf.mark('host-election')

if (isHost) {
	console.log(`Server started (pid ${process.pid}) [${perf.elapsed()}ms]`)
} else {
	console.log(`Joined server (pid ${serverPid}) [${perf.elapsed()}ms]`)
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
}

// Client: watch for host-released event, promote immediately
// Fallback: poll server PID every 3s in case of crash
if (!isHost) {
	let promoting = false

	const tryPromote = async () => {
		if (promoting || isHost) return
		promoting = true
		try {
			if (await claimHost()) {
				isHost = true
				serverPid = process.pid
				console.log(`Promoted to server (pid ${process.pid})`)
				startRuntime(ac.signal)
			}
		} finally {
			promoting = false
		}
	}

	// Fast path: host announces it's quitting
	;(async () => {
		for await (const event of tailEvents(ac.signal)) {
			if (event.type === 'host-released') {
				tryPromote()
			}
		}
	})()

	// Slow fallback: poll for crash
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
	}, 3000)

	ac.signal.addEventListener('abort', () => clearInterval(pollTimer))
}

// Dump perf marks to stderr on startup
perf.setSink((lines) => {
	for (const line of lines) process.stderr.write(`  ${line}\n`)
})

perf.mark('cli-start')
startCli(ac.signal)
