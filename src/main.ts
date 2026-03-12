#!/usr/bin/env bun
// Entry point — host election, promotion, then start runtime + CLI.

import { randomBytes } from 'crypto'
import { state } from './state.ts'
import { ipc } from './ipc.ts'
import { startup } from './runtime/startup.ts'
import { type Runtime } from './runtime/runtime.ts'
import { protocol } from './protocol.ts'

state.ensureStateDir()
await ipc.ensureBus()

const startupEpochRaw = process.env.HAL_STARTUP_EPOCH_MS
const startupEpochMs = startupEpochRaw ? Number.parseInt(startupEpochRaw, 10) : NaN
const startupEpoch = Number.isFinite(startupEpochMs) && startupEpochMs > 0 ? startupEpochMs : null

const hostId = `${process.pid}-${randomBytes(4).toString('hex')}`
const { host, currentPid } = await ipc.claimHost(hostId)

// Shared mutable state — cli/cli.ts reads this for the separator
export const halStatus = { isHost: host, hostPid: currentPid, startupEpochMs: startupEpoch, startupReadyElapsedMs: null as number | null }
;(globalThis as any).__hal = halStatus

let runtime: Runtime | null = null

async function emitLine(text: string): Promise<void> {
	await ipc.events.append({
		id: protocol.eventId(), type: 'line', sessionId: null,
		text, level: 'meta', createdAt: new Date().toISOString(),
	} as any)
}

async function becomeHost(promoted = false): Promise<void> {
	runtime = await startup.startRuntime({ promoted })
	await emitLine(`[host] pid ${process.pid}`)
	// Heartbeat: verify lock is still ours every 3s. If lost (e.g. suspended
	// and another process took over), step down and let restart loop re-launch.
	setInterval(async () => {
		if (!halStatus.isHost) return
		if (!(await ipc.verifyHost(hostId))) {
			await emitLine(`[host] lock lost (pid ${process.pid}), stepping down`)
			if (runtime) runtime.stop()
			runtime = null
			halStatus.isHost = false
			process.exit(100)
		}
	}, 3000)
}

export async function shutdown(): Promise<void> {
	if (runtime) runtime.stop()
	if (halStatus.isHost) await ipc.releaseHost(hostId)
	process.exit(0)
}

process.on('SIGTERM', () => void shutdown())

if (host) {
	await becomeHost(false)
}

// If client, fast-poll host PID then promote when dead
if (!host) {
	let promoting = false
	const tryPromote = async () => {
		if (promoting || halStatus.isHost) return
		promoting = true
		try {
			const result = await ipc.claimHost(hostId)
			if (!result.host) {
				watchPid = result.currentPid
				if (watchPid !== null) halStatus.hostPid = watchPid
				return
			}
			halStatus.isHost = true
			halStatus.hostPid = process.pid
			await becomeHost(true)
			if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
		} finally {
			promoting = false
		}
	}
	let watchPid = currentPid
	let pollTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
		if (halStatus.isHost || promoting) return
		if (watchPid !== null) {
			try { process.kill(watchPid, 0) } catch { watchPid = null }
		}
		if (watchPid === null) tryPromote()
	}, 100)

	// Also expose for event-driven promotion (client calls this on [host-released])
	;(globalThis as any).__halTryPromote = tryPromote
}

// Start CLI
await import('./cli/cli.ts')