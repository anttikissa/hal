import { perf } from './client/perf.ts'
perf.mark('First line of code executed')

import { ensureStateDir, HAL_DIR, STATE_DIR } from './server/state.ts'
import { ipc } from './server/file-ipc.ts'
import { runtime } from './server/runtime.ts'
import { cli } from './client/cli.ts'
import { client } from './client/app.ts'
import { clientBackend, type SubscriptionStatus } from './client/backend.ts'
import { clientTransport } from './client/transport.ts'
import { memory } from './server/memory.ts'
import { version } from './server/version.ts'
import { isPidAlive } from './utils/is-pid-alive.ts'
import { log } from './utils/log.ts'
import { config } from './config.ts'
import { builtins } from './server/tools/builtins.ts'
import { colors } from './client/terminal/colors.ts'
import { openaiUsage } from './server/openai-usage.ts'
import { anthropicUsage } from './server/anthropic-usage.ts'
import { resolve } from 'path'
import { tabs } from './server/tabs.ts'
import { auth } from './server/auth.ts'
import { sessions as sessionStore } from './server/sessions.ts'
import { cliArgs } from './client/terminal/args.ts'
import { terminalOutput } from './client/terminal-output.ts'
import { serverModels } from './server/models.ts'

function subscriptionStatus(provider: string): SubscriptionStatus | null {
	if (provider === 'openai') {
		const account = openaiUsage.current()
		if (!account) return null
		return {
			index: account.index,
			total: account.total,
			windows: openaiUsage.displayWindows(account).map((item) => ({ label: item.label, usedPercent: item.window.usedPercent })),
		}
	}
	if (provider === 'anthropic') {
		const account = anthropicUsage.current()
		if (!account) return null
		const windows: SubscriptionStatus['windows'] = []
		if (account.fiveHour?.usedPercent != null) windows.push({ label: '5h', usedPercent: account.fiveHour.usedPercent })
		if (account.sevenDay?.usedPercent != null) windows.push({ label: '7d', usedPercent: account.sevenDay.usedPercent })
		return { index: account.index, total: account.total, windows }
	}
	return null
}

const parsedArgs = cliArgs.parse(process.argv.slice(2), { cwd: process.cwd(), halDir: HAL_DIR })
if (!parsedArgs.ok) {
	process.stderr.write(`${parsedArgs.error}\n\n${cliArgs.helpText()}\n`)
	process.exit(2)
}
if (parsedArgs.help) {
	terminalOutput.write(`${cliArgs.helpText()}\n`)
	process.exit(0)
}
if (parsedArgs.stateDir && process.env.HAL_STATE_DIR !== parsedArgs.stateDir) {
	process.stderr.write('--state-dir must be handled by the hal wrapper so HAL_STATE_DIR is set before startup. Use `hal --state-dir <dir>`.\n')
	process.exit(2)
}
const startupCwd = resolve(parsedArgs.targetCwd || '.')

ensureStateDir()
log.state.path = `${STATE_DIR}/hal.log`
perf.mark('State directories exist')
config.init()
perf.mark('Config initialized')
serverModels.init()
perf.mark('Model metadata initialized')
colors.init()
perf.mark('Colors initialized')
openaiUsage.init()
perf.mark('OpenAI usage initialized')
anthropicUsage.init()
perf.mark('Anthropic usage initialized')
clientBackend.install({
	paths: { halDir: HAL_DIR, stateDir: STATE_DIR },
	sessions: {
		sessionDir: (sessionId) => sessionStore.sessionDir(sessionId),
		loadAllSessionMetas: () => sessionStore.loadAllSessionMetas(),
		loadSessionMeta: (sessionId) => sessionStore.loadSessionMeta(sessionId),
		loadHistoryLog: (sessionId, logName, limit) => sessionStore.loadHistoryLog(sessionId, logName, limit),
		loadAllHistoryWithOrigin: (sessionId) => sessionStore.loadAllHistoryWithOrigin(sessionId),
		loadLive: (sessionId) => sessionStore.loadLive(sessionId),
	},
	subscriptions: {
		isApiKey: (provider) => auth.isApiKey(provider),
		current: subscriptionStatus,
		noteActivity: () => openaiUsage.noteActivity(),
		onChange: (callback) => openaiUsage.onChange(callback),
	},
})
clientTransport.install({
	appendCommand: (command) => ipc.appendCommand(command),
	notifyDraftSaved: (sessionId) => ipc.appendCommand({ type: 'draft-saved', sessionId }),
	readState: () => ipc.readState(),
	tailEvents: (signal) => ipc.tailEvents(signal),
})
memory.io.addEntry = (text, type) => client.addEntry(text, type)
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
let startupTarget: { preferredSessionId?: string; openCwd?: string } = {}

function failStartup(message: string, code = 1): never {
	process.stderr.write(`${message}\n`)
	if (isHost) ipc.releaseHost()
	perf.stop()
	process.exit(code)
}

// This executable is a same-machine peer: it shares the server's path namespace
// and may be promoted to server. A future remote terminal client must select by
// server URL/session ID instead of comparing its local cwd.

function prepareClientStartupTarget(cwd: string): { preferredSessionId?: string; openCwd?: string } {
	const shared = ipc.readState()
	const openId = tabs.findOpenSessionForCwd(shared.sessions, cwd)
	if (openId) {
		log.info('Client startup target already open', {
			cwd,
			sessionId: openId,
			openSessions: shared.sessions.length,
			stateUpdatedAt: shared.updatedAt,
		})
		return { preferredSessionId: openId }
	}

	if (shared.sessions.length >= tabs.config.maxTabs) {
		failStartup(`Cannot open ${cwd}: max tabs reached (${tabs.config.maxTabs}). Close one first.`)
	}

	log.info('Client startup target queued for host', {
		cwd,
		hostPid,
		openSessions: shared.sessions.length,
		stateUpdatedAt: shared.updatedAt,
	})
	return { openCwd: cwd }
}

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
		state.clients = (state.clients ?? []).filter((item) => item.pid !== process.pid)
	})
}

function syncLocalVersionState(): void {
	client.state.localVersionStatus = version.state.status
	client.state.localVersion = version.state.combined
	client.state.localVersionError = version.state.error
}

version.onChange(() => {
	syncLocalVersionState()
	if (isHost) syncHostVersionState()
	else client.publishStatus()
	client.requestRender(false)
})

function becomeHost(kind: 'start' | 'promote'): void {
	isHost = true
	client.state.role = 'server'
	client.state.localCommandHandler = (command) => { runtime.handleCommand(command) }
	const announceWeb = kind === 'start' && ipc.readState().sessions.length === 0
	syncHostVersionState()
	const started = runtime.startRuntime(ac.signal, { targetCwd: startupCwd })
	if (!started.ok) failStartup(started.reason)
	startupTarget.preferredSessionId = started.sessionId
	if (parsedArgs.ok && parsedArgs.webPort) {
		const port = parsedArgs.webPort
		void import('./server/web.ts')
			.then(({ web }) => web.start(port, ac.signal, announceWeb ? started.sessionId : undefined))
			.catch((error) => log.error('web client startup failed', { error: String(error) }))
	}
	ipc.appendEvent({
		type: 'runtime-start',
		pid: process.pid,
		startedAt: ipc.readHostLock()?.createdAt ?? new Date().toISOString(),
		reason: kind,
	})
	if (kind === 'promote') client.addStartupEntry(`Promoted to server (pid ${process.pid})`)
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
	} else {
		client.publishExit()
	}
	perf.stop()
}

function tickElection(): void {
	if (isHost) {
		if (ipc.ownsHostLock()) return
		isHost = false
		client.state.role = 'client'
		client.state.localCommandHandler = null
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
else {
	startupTarget = prepareClientStartupTarget(startupCwd)
}

process.on('exit', cleanup)
process.on('SIGTERM', () => {
	cleanup()
	process.exit(0)
})
// Monitor only observes fatal exceptions; it does not change normal crash behavior.
process.on('uncaughtExceptionMonitor', (err) => {
	memory.recordPossibleOom(err)
})

queueMemoryCheck()

electionTimer = setInterval(tickElection, 100)

cli.startCli(ac.signal, startupTarget)
if (!isHost) client.publishStatus()
