import { perf } from './perf.ts'
perf.mark('First line of code executed')

import { ensureStateDir } from './state.ts'
import { ipc } from './ipc.ts'
import { runtime } from './server/runtime.ts'
import { cli } from './client/cli.ts'
import { client } from './client.ts'
import { memory } from './memory.ts'
import { version } from './version.ts'
import { isPidAlive } from './utils/is-pid-alive.ts'
import { log } from './utils/log.ts'
import { config } from './config.ts'
import { builtins } from './tools/builtins.ts'
import { colors } from './cli/colors.ts'

ensureStateDir()
perf.mark('State directories exist')
config.init()
perf.mark('Config initialized')
colors.init()
perf.mark('Colors initialized')
builtins.init()
perf.mark('Built-in tools registered')

ipc.cleanupStaleLock()
let isHost = ipc.claimHost()
const hostPid = ipc.readHostLock()?.pid ?? null
perf.mark(`Host status established (I am ${isHost ? 'host' : 'client'}, server pid ${hostPid})`)
log.info('Startup', { isHost, hostPid, pid: process.pid })

const ac = new AbortController()
let electionTimer: ReturnType<typeof setInterval> | null = null
let cleaned = false
let memoryTimer: ReturnType<typeof setTimeout> | null = null

function syncHostVersionState(): void {
	if (!isHost) return
	const lock = ipc.readHostLock()
	ipc.updateState((state) => {
		state.host = {
			pid: process.pid,
			startedAt: lock?.createdAt ?? state.host?.startedAt ?? '',
			versionStatus: version.state.status,
			version: version.state.combined || undefined,
			error: version.state.error || undefined,
		}
	})
}

version.onChange(() => {
	if (isHost) syncHostVersionState()
	client.requestRender(false)
})

function becomeHost(kind: 'start' | 'promote'): void {
	isHost = true
	client.state.role = 'server'
	syncHostVersionState()
	ipc.appendEvent({
		type: 'runtime-start',
		pid: process.pid,
		startedAt: ipc.readHostLock()?.createdAt ?? new Date().toISOString(),
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
version.start()
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
