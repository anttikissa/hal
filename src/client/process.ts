import { clientTransport } from './transport.ts'
import { clientBackend } from './backend.ts'
import { log } from '../utils/log.ts'

const state = { started: false }

function reset(): void {
	state.started = false
}

function applyState(shared: ReturnType<typeof clientTransport.io.readState>, ctx: any): void {
	ctx.setHostPid(shared.host?.pid ?? null)
	ctx.applySharedState(shared)
	ctx.onChange(false)
}

function start(signal: AbortSignal, opts: any, ctx: any): void {
	if (state.started) return
	state.started = true
	const shared = clientTransport.io.readState()
	ctx.setHostPid(shared.host?.pid ?? null)
	clientTransport.io.watchState((next) => clientProcess.applyState(next, ctx), signal)
	clientBackend.subscriptions.onChange(() => ctx.onChange(false))
	void (async () => {
		for await (const event of clientTransport.io.tailEvents(signal)) ctx.handleEvent(event)
	})()
	ctx.initializeSessions(shared, opts)
	if (!opts.openCwd) ctx.focusCurrentTab()
	if (opts.openCwd) {
		ctx.onStartupOpen()
		clientTransport.io.appendCommand({ type: 'open', cwd: opts.openCwd, sessionId: ctx.currentSessionId() })
		log.info('Client queued startup open command', { cwd: opts.openCwd, sessionId: ctx.currentSessionId() ?? null })
	}
	ctx.onChange(false)
	void ctx.loadInBackground()
}

export const clientProcess = { state, reset, applyState, start }
