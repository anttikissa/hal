#!/usr/bin/env bun
// Entry point — host election, promotion, then start runtime + CLI.

import { randomBytes } from 'crypto'
import { ensureStateDir } from './state.ts'
import { ensureBus, claimHost, releaseHost, appendEvent } from './ipc.ts'
import { startRuntime, type Runtime } from './runtime/runtime.ts'
import { eventId } from './protocol.ts'

ensureStateDir()
await ensureBus()

const hostId = `${process.pid}-${randomBytes(4).toString('hex')}`
const { host, currentPid } = await claimHost(hostId)

// Shared mutable state — cli.ts reads this for the separator
export const halStatus = { isHost: host, hostPid: currentPid }
;(globalThis as any).__hal = halStatus

let runtime: Runtime | null = null

async function emitLine(text: string): Promise<void> {
	await appendEvent({
		id: eventId(), type: 'line', sessionId: null,
		text, level: 'meta', createdAt: new Date().toISOString(),
	})
}

async function becomeHost(): Promise<void> {
	runtime = await startRuntime()
	await emitLine(`[host] pid ${process.pid}`)
}

export async function shutdown(): Promise<void> {
	if (runtime) runtime.stop()
	if (halStatus.isHost) await releaseHost(hostId)
	process.exit(0)
}

process.on('SIGTERM', () => void shutdown())

if (host) {
	await becomeHost()
}

// If client, fast-poll host PID then promote when dead
if (!host) {
	let promoting = false
	const tryPromote = async () => {
		if (promoting || halStatus.isHost) return
		promoting = true
		try {
			const result = await claimHost(hostId)
			if (!result.host) return
			halStatus.isHost = true
			halStatus.hostPid = process.pid
			await becomeHost()
			if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
		} finally {
			promoting = false
		}
	}
	// Fallback for ungraceful death (SIGKILL/crash) — 1s is plenty
	let watchPid = currentPid
	let pollTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
		if (halStatus.isHost || promoting) return
		if (watchPid !== null) {
			try { process.kill(watchPid, 0) } catch { watchPid = null }
		}
		if (watchPid === null) tryPromote()
	}, 1000)

	// Also expose for event-driven promotion (client calls this on [host-released])
	;(globalThis as any).__halTryPromote = tryPromote
}

// Start CLI
await import('./cli.ts')
