import { perf } from './perf.ts'
perf.mark('First line of code executed')

import { ensureStateDir } from './state.ts'
import { ipc } from './ipc.ts'
import { runtime } from './server/runtime.ts'
import { cli } from './client/cli.ts'
import { client } from './client.ts'
import { memory } from './memory.ts'
import { isPidAlive } from './utils/is-pid-alive.ts'
import { log } from './utils/log.ts'
import './config.ts' // load config.ason overrides, watch for changes

ensureStateDir()
perf.mark('State directories exist')

ipc.cleanupStaleLock()
let isHost = ipc.claimHost()
const hostPid = ipc.readHostLock()?.pid ?? null
perf.mark(`Host status established (I am ${isHost ? 'host' : 'client'}, server pid ${hostPid})`)
log.info('Startup', { isHost, hostPid, pid: process.pid })

const ac = new AbortController()
let electionTimer: ReturnType<typeof setInterval> | null = null
let cleaned = false
let memoryTimer: ReturnType<typeof setTimeout> | null = null

function becomeHost(kind: 'start' | 'promote'): void {
	isHost = true
	client.state.role = 'server'
	ipc.appendEvent({
		type: 'runtime-start',
		pid: process.pid,
		startedAt: new Date().toISOString(),
	})
	if (kind === 'promote') client.addStartupEntry(`Promoted to server (pid ${process.pid})`)
	runtime.startRuntime(ac.signal)
}

function queueMemoryCheck(): void {
	if (cleaned) return
	memoryTimer = setTimeout(() => {
		memory.tick()
		queueMemoryCheck()
	}, memory.config.checkIntervalMs)
}

function cleanup(): void {
	if (cleaned) return
	cleaned = true
	log.info('Cleanup started', { isHost, pid: process.pid })
	if (electionTimer) clearInterval(electionTimer)
	if (memoryTimer) clearTimeout(memoryTimer)
	ac.abort()
	if (isHost) {
		ipc.appendEvent({ type: 'host-released' })
		ipc.releaseHost()
	}
	perf.stop()
}

function tickElection(): void {
	if (isHost) {
		if (ipc.ownsHostLock()) return
		isHost = false
		client.state.role = 'client'
		log.info('Lost host lock, exiting', { pid: process.pid, lockPid: ipc.readHostLock()?.pid ?? null })
		process.exit(0)
	}

	const lock = ipc.readHostLock()
	if (lock && isPidAlive(lock.pid)) return
	ipc.cleanupStaleLock()
	if (ipc.claimHost()) becomeHost('promote')
}

client.state.role = isHost ? 'server' : 'client'
if (isHost) {
	becomeHost('start')
}

process.on('exit', cleanup)
process.on('SIGTERM', () => {
	cleanup()
	process.exit(0)
})

queueMemoryCheck()

electionTimer = setInterval(tickElection, 100)

cli.startCli(ac.signal)
