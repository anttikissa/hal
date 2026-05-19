import { ipc } from '../ipc.ts'
import { openaiUsage } from '../openai-usage.ts'
import { STATE_DIR } from '../state.ts'
import { liveFiles } from '../utils/live-file.ts'
import { log } from '../utils/log.ts'

const state = {
	hostLockState: null as { pid: number | null; createdAt: string } | null,
	ipcStateFile: null as any,
}

function reset(): void {
	state.hostLockState = null
	state.ipcStateFile = null
}

function syncHostPid(ctx: any): void {
	ctx.setHostPid(state.hostLockState?.pid ?? null)
}

function startWatchingHostLock(ctx: any): void {
	if (state.hostLockState) return
	state.hostLockState = liveFiles.liveFile(`${STATE_DIR}/ipc/host.lock`, { pid: null, createdAt: '' })
	syncHostPid(ctx)
	liveFiles.onChange(state.hostLockState, () => {
		syncHostPid(ctx)
		ctx.onChange(false)
	})
}

function startWatchingIpcState(ctx: any) {
	if (!state.ipcStateFile) {
		state.ipcStateFile = liveFiles.liveFile(`${STATE_DIR}/ipc/state.ason`, ipc.readState())
		liveFiles.onChange(state.ipcStateFile, () => {
			ctx.applySharedState(state.ipcStateFile!)
			ctx.onChange(false)
		})
	}
	return state.ipcStateFile
}

function start(signal: AbortSignal, opts: any, ctx: any): void {
	startWatchingHostLock(ctx)
	const shared = startWatchingIpcState(ctx)
	openaiUsage.onChange(() => ctx.onChange(false))
	void (async () => {
		for await (const event of ipc.tailEvents(signal)) ctx.handleEvent(event)
	})()
	ctx.initializeSessions(shared, opts)
	if (opts.openCwd) {
		ctx.onStartupOpen()
		ipc.appendCommand({ type: 'open', cwd: opts.openCwd, sessionId: ctx.currentSessionId() })
		log.info('Client queued startup open command', { cwd: opts.openCwd, sessionId: ctx.currentSessionId() ?? null })
	}
	ctx.onChange(false)
	void ctx.loadInBackground()
}

export const clientProcess = { state, reset, syncHostPid, startWatchingHostLock, startWatchingIpcState, start }
