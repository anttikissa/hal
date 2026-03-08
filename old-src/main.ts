#!/usr/bin/env bun
import { headless, testMode } from './args.ts'
import { randomBytes } from 'crypto'
import {
	appendEvent,
	claimOwner,
	initBus,
	ensureBus,
	releaseOwner,
	resetBusEvents,
	verifyOwnership,
} from './ipc.ts'
import { startRuntime, saveAllSessions } from './runtime/sessions.ts'
import {
	init as initClient,
	start as startClient,
	promoteToOwner,
	setOwnerReleaseHandler,
} from './cli/client.ts'

import { startWebServer } from './web.ts'
import type { EventLevel } from './protocol.ts'
import { registerProvider } from './provider.ts'
import { anthropicProvider } from './providers/anthropic.ts'
import { openaiProvider } from './providers/openai.ts'
import { mockProvider } from './providers/mock.ts'
import { ollamaProvider } from './providers/ollama.ts'
import { registerConfigProviders } from './providers/factory.ts'
import { STATE_DIR } from './state.ts'
import { initDebugLog } from './debug-log.ts'

if (testMode) {
	const { testAnthropicProvider, testOpenaiProvider, testOllamaProvider } = await import(
		'./providers/test.ts',
	)
	registerProvider(testAnthropicProvider)
	registerProvider(testOpenaiProvider)
	registerProvider(testOllamaProvider)
} else {
	registerProvider(anthropicProvider)
	registerProvider(openaiProvider)
	registerProvider(ollamaProvider)
	registerConfigProviders()
}
registerProvider(mockProvider)

initBus()
await ensureBus()
if (process.env.HAL_TEST_NO_UI !== '1') await initDebugLog(process.pid)

// Startup perf: read epoch saved by run script
const startupEpochFile = `/tmp/hal-startup-${process.ppid}.txt`
let startupEpoch: number | null = null
try {
	const raw = await Bun.file(startupEpochFile).text()
	startupEpoch = parseInt(raw.trim(), 10)
} catch {}

const configuredWebPort = Number.parseInt(process.env.HAL_WEB_PORT ?? '9001', 10)
const webPort =
	Number.isFinite(configuredWebPort) && configuredWebPort > 0 ? configuredWebPort : 9001

const ownerId = `${process.pid}-${randomBytes(4).toString('hex')}`
const clientId = randomBytes(3).toString('hex')

const claim = await claimOwner(ownerId)
const isOwner = claim.owner

let webServer: ReturnType<typeof startWebServer> | null = null

let eventCounter = 0
const emitBootstrap = async (text: string, level: EventLevel = 'status') => {
	eventCounter += 1
	await appendEvent({
		id: `${Date.now()}-${process.pid}-bootstrap-${eventCounter}`,
		type: 'line',
		sessionId: null,
		level,
		text,
		createdAt: new Date().toISOString(),
	})
}

function isAddrInUse(error: unknown): boolean {
	const msg = String((error as any)?.message ?? error ?? '')
	return (
		(error as any)?.code === 'EADDRINUSE' ||
		msg.includes('EADDRINUSE') ||
		msg.includes('Address already in use')
	)
}

function listListeningPids(port: number): { pid: number; command: string }[] {
	const platform = process.platform
	let result: { exitCode: number; stdout: { toString(): string } }
	if (platform === 'darwin') {
		result = Bun.spawnSync(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'])
	} else {
		// Linux: use ss + parse, or fuser as fallback
		result = Bun.spawnSync(['fuser', `${port}/tcp`])
	}
	if (result.exitCode !== 0) return []
	const pids: number[] = []
	if (platform === 'darwin') {
		for (const line of result.stdout.toString().split('\n')) {
			if (line.startsWith('p')) {
				const pid = parseInt(line.slice(1), 10)
				if (pid > 0) pids.push(pid)
			}
		}
	} else {
		for (const tok of result.stdout.toString().trim().split(/\s+/)) {
			const pid = parseInt(tok, 10)
			if (pid > 0) pids.push(pid)
		}
	}
	return pids
		.filter((pid) => pid !== process.pid)
		.map((pid) => {
			const ps = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)])
			const command = ps.exitCode === 0 ? ps.stdout.toString().trim() : ''
			return { pid, command }
		})
}

function findSuspendedHalProcesses(port: number): { pid: number; command: string }[] {
	return listListeningPids(port).filter(({ pid, command }) => {
		const ps = Bun.spawnSync(['ps', '-o', 'state=', '-p', String(pid)])
		const state = ps.exitCode === 0 ? ps.stdout.toString().trim() : ''
		const isSuspended = state.startsWith('T')
		const looksLikeHal = command.includes('bun main.ts') || command.includes('/bin/bash ./run')
		return isSuspended && looksLikeHal
	})
}

if (isOwner) {
	await resetBusEvents()
	await emitBootstrap(`[owner] pid ${process.pid}`)
	if (STATE_DIR.startsWith('/tmp/hal/state/')) await emitBootstrap(`[fresh] state dir: ${STATE_DIR}`)
	try {
		webServer = startWebServer(webPort)
		await emitBootstrap(`[web] http://localhost:${webServer.port}`)
	} catch (e: any) {
		if (isAddrInUse(e)) {
			const suspended = findSuspendedHalProcesses(webPort)
			if (suspended.length > 0) {
				const pids = suspended.map((s) => s.pid).join(', ')
				process.stdout.write(
					`\nPort ${webPort} held by suspended HAL process${suspended.length > 1 ? 'es' : ''} (PID ${pids})\nKill and reclaim? [Y/n] `,
				)
				const response = await new Promise<string>((resolve) => {
					let buf = ''
					const onData = (chunk: Buffer) => {
						buf += chunk.toString()
						if (buf.includes('\n')) {
							process.stdin.removeListener('data', onData)
							process.stdin.pause()
							if ((process.stdin as any).setRawMode)
								(process.stdin as any).setRawMode(false)
							resolve(buf.trim())
						}
					}
					process.stdin.resume()
					process.stdin.on('data', onData)
				})
				if (
					!response ||
					response.toLowerCase() === 'y' ||
					response.toLowerCase() === 'yes'
				) {
					for (const { pid } of suspended) {
						try {
							process.kill(pid, 'SIGKILL')
						} catch {}
					}
					await Bun.sleep(200)
					try {
						webServer = startWebServer(webPort)
						await emitBootstrap(
							`[web] http://localhost:${webServer.port} (reclaimed from PID ${pids})`,
						)
					} catch (retryErr: any) {
						await emitBootstrap(
							`[web] disabled: ${retryErr.message || retryErr}`,
							'warn',
						)
					}
				} else {
					await emitBootstrap(`[web] disabled: port ${webPort} in use`, 'warn')
				}
			} else {
				await emitBootstrap(
					`[web] disabled: port ${webPort} in use by another process`,
					'warn',
				)
			}
		} else {
			await emitBootstrap(`[web] disabled: ${e.message || e}`, 'warn')
		}
	}

	startRuntime(ownerId).catch(async (e) => {
		await emitBootstrap(`[engine] crashed: ${e.message || e}`, 'error')
		await releaseOwner(ownerId)
		process.exit(1)
	})

	// Heartbeat: verify we still hold the lock. If lost (e.g. we were suspended
	// and another process took over), exit and let the restart loop re-launch us.
	setInterval(async () => {
		if (!(await verifyOwnership(ownerId))) {
			await emitBootstrap(`[owner] lock lost (pid ${process.pid}), stepping down`, 'warn')
			await saveAllSessions()
			if (webServer) webServer.stop()
			process.exit(100)
		}
	}, 3000)
}

if (testMode) {
	// Test mode: structured JSON output, line-based stdin, no TUI
	const { tailEvents, appendCommand } = await import('./ipc.ts')
	const { makeCommand } = await import('./protocol.ts')
	const { isExit } = await import('./cli/commands.ts')

	const testSource = { kind: 'cli' as const, clientId }

	const writeLine = (record: any) => {
		process.stdout.write(JSON.stringify(record) + '\n')
	}

	// Start runtime (we are always owner in test mode)
	startRuntime(ownerId).catch(async (e) => {
		writeLine({ type: 'error', text: `runtime crashed: ${e.message || e}` })
		await releaseOwner(ownerId)
		process.exit(1)
	})

	// Tail events → structured stdout; emit 'ready' after first status event
	let readySent = false
	void (async () => {
		for await (const event of tailEvents()) {
			if (event.type === 'line') {
				writeLine({
					type: 'line',
					level: event.level,
					session: event.sessionId,
					text: event.text,
				})
			} else if (event.type === 'chunk') {
				writeLine({
					type: 'chunk',
					channel: event.channel,
					session: event.sessionId,
					text: event.text,
				})
			} else if (event.type === 'prompt') {
				writeLine({
					type: 'prompt',
					session: event.sessionId,
					text: event.text,
					...(event.label ? { label: event.label } : {}),
				})
			} else if (event.type === 'sessions') {
				writeLine({
					type: 'sessions',
					active: event.activeSessionId,
					sessions: event.sessions,
				})
			} else if (event.type === 'status') {
				writeLine({
					type: 'status',
					busy: event.busy,
					busySessions: event.busySessionIds,
					pausedSessions: event.pausedSessionIds,
					session: event.sessionId,
					...(event.context ? { context: event.context } : {}),
				})
				// Emit ready after first full status (runtime initialized)
				if (!readySent) {
					readySent = true
					writeLine({ type: 'ready' })
				}
			} else if (event.type === 'tool_progress') {
				writeLine({
					type: 'tool_progress',
					session: event.sessionId,
					tools: event.tools,
				})
			} else if (event.type === 'command') {
				writeLine({
					type: 'command',
					commandId: event.commandId,
					phase: event.phase,
					message: event.message,
					session: event.sessionId,
				})
			}
		}
	})()

	// Read stdin lines → send as commands
	const reader = (await import('readline')).createInterface({ input: process.stdin })
	for await (const line of reader) {
		const trimmed = line.trim()
		if (!trimmed) continue
		if (isExit(trimmed.toLowerCase())) break
		if (trimmed.startsWith('/')) {
			const spaceIdx = trimmed.indexOf(' ')
			const name = spaceIdx < 0 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)
			const args = spaceIdx < 0 ? '' : trimmed.slice(spaceIdx + 1).trim()
			const cmd = makeCommand(name as any, testSource, args || undefined, null)
			await appendCommand(cmd)
		} else {
			const cmd = makeCommand('prompt', testSource, trimmed, null)
			await appendCommand(cmd)
		}
	}

	// Cleanup
	if (webServer) webServer.stop()
	await saveAllSessions()
	await releaseOwner(ownerId)
	process.exit(0)
} else if (headless) {
	if (!isOwner) {
		await emitBootstrap('[runtime] --headless but not owner; exiting', 'warn')
		process.exit(0)
	}
	await emitBootstrap('[runtime] headless mode', 'status')
	const shutdown = async () => {
		if (webServer) webServer.stop()
		await saveAllSessions()
		await releaseOwner(ownerId)
		process.exit(0)
	}

	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
	await new Promise(() => {})
} else {
	initClient({ kind: 'cli', clientId }, isOwner)
	let exitCode = 0
	let exitingViaSigint = false
	let promoted = false

	async function tryPromote(): Promise<void> {
		if (isOwner || promoted) return
		const result = await claimOwner(ownerId)
		if (!result.owner) return
		promoted = true
		if (ownerWatchTimer) {
			clearInterval(ownerWatchTimer)
			ownerWatchTimer = null
		}

		promoteToOwner()
		await emitBootstrap(`[promoted] pid ${process.pid} is now the owner`)
		// Retry web server with exponential backoff — port may still be closing
		let delay = 350
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				webServer = startWebServer(webPort)
				await emitBootstrap(`[web] http://localhost:${webServer.port}`)
				break
			} catch (e: any) {
				if (isAddrInUse(e)) {
				// If another HAL owner took over during retry, stop trying in this process.
					if (!(await verifyOwnership(ownerId))) {
						await emitBootstrap('[web] skipped: another owner is active', 'status')
						break
					}
					if (attempt === 9) {
						await emitBootstrap(`[web] disabled: ${e.message || e}`, 'warn')
						break
					}
					await Bun.sleep(delay)
					delay = Math.min(delay * 1.4, 10000)
					continue
				}
				await emitBootstrap(`[web] disabled: ${e.message || e}`, 'warn')
				break
			}
		}

		startRuntime(ownerId).catch(async (e) => {
			await emitBootstrap(`[engine] crashed: ${e.message || e}`, 'error')
			await releaseOwner(ownerId)
		})

		// Heartbeat for promoted owner — same as initial owner
		setInterval(async () => {
			if (!(await verifyOwnership(ownerId))) {
				await emitBootstrap(`[owner] lock lost (pid ${process.pid}), stepping down`, 'warn')
				await saveAllSessions()
				if (webServer) webServer.stop()
				process.exit(100)
			}
		}, 3000)
	}

	// If we're a client, watch for owner release event + fast PID poll as fallback
	let ownerWatchTimer: ReturnType<typeof setInterval> | null = null
	if (!isOwner) {
		setOwnerReleaseHandler(() => tryPromote())
		// Fast poll: bare kill(pid,0) syscall every 100ms — essentially free
		let watchPid = claim.currentOwnerPid
		let promoting = false
		ownerWatchTimer = setInterval(() => {
			if (promoted || promoting) return
			if (watchPid !== null) {
				try { process.kill(watchPid, 0) } catch { watchPid = null }
			}
			if (watchPid === null) { promoting = true; tryPromote().finally(() => { promoting = false }) }
		}, 100)
	}

	const shutdown = async (code: number) => {
		if (ownerWatchTimer) clearInterval(ownerWatchTimer)
		if (webServer) webServer.stop()
		if (isOwner || promoted) {
			await saveAllSessions()
			await releaseOwner(ownerId)
		}
		process.exit(code)
	}

	process.on('SIGINT', () => {
		if (exitingViaSigint) return
		exitingViaSigint = true
		void shutdown(100)
	})
	process.on('SIGHUP', () => void shutdown(0))
	process.on('SIGTERM', () => void shutdown(0))

	try {
		exitCode = await startClient({ startupEpoch })
	} catch (e: any) {
		exitCode = 1
		await emitBootstrap(`[cli] crashed: ${e?.message || e}`, 'error')
	}

	await shutdown(exitCode)
}
