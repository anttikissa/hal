#!/usr/bin/env bun
// Entry point — host election, promotion, then start runtime + CLI.

import { randomBytes } from 'crypto'
import { ensureStateDir } from './state.ts'
import { ensureBus, claimHost, releaseHost, appendEvent } from './ipc.ts'
import { startRuntime, type Runtime } from './runtime/runtime.ts'
import { eventId } from './protocol.ts'
import { isPidAlive } from './utils/is-pid-alive.ts'

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

async function shutdown(): Promise<void> {
	if (runtime) runtime.stop()
	if (halStatus.isHost) await releaseHost(hostId)
}

if (host) {
	await becomeHost()
}

// Synchronous fallback — exit handler can't await but at least tries
process.on('exit', () => { try { releaseHost(hostId) } catch {} })
process.on('SIGINT', () => { shutdown().then(() => process.exit(0)) })
process.on('SIGTERM', () => { shutdown().then(() => process.exit(0)) })

// If client, poll for dead host and try to promote
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
			if (promotionTimer) { clearInterval(promotionTimer); promotionTimer = null }
		} finally {
			promoting = false
		}
	}
	let promotionTimer: ReturnType<typeof setInterval> | null = setInterval(tryPromote, 3000)

	// Also expose for event-driven promotion (client calls this on [owner-released])
	;(globalThis as any).__halTryPromote = tryPromote
}

// Start CLI
await import('./cli.ts')
