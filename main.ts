#!/usr/bin/env bun
import { fresh, headless } from "./src/args.ts"
import { randomBytes } from "crypto"
import {
	appendEvent,
	claimOwner,
	initBus,
	ensureBus,
	releaseOwner,
	resetBusEvents,
} from "./src/ipc.ts"
import { startRuntime } from "./src/runtime/sessions.ts"
import { init as initClient, start as startClient } from "./src/cli/client.ts"
import { startWebServer } from "./src/web.ts"
import type { EventLevel } from "./src/protocol.ts"
import { registerProvider } from "./src/provider.ts"
import { anthropicProvider } from "./src/providers/anthropic.ts"
import { openaiProvider } from "./src/providers/openai.ts"
import { STATE_DIR } from "./src/state.ts"

registerProvider(anthropicProvider)
registerProvider(openaiProvider)

initBus()
await ensureBus()

const configuredWebPort = Number.parseInt(process.env.HAL_WEB_PORT ?? "9001", 10)
const webPort = Number.isFinite(configuredWebPort) && configuredWebPort > 0 ? configuredWebPort : 9001

const ownerId = `${process.pid}-${randomBytes(4).toString("hex")}`
const clientId = randomBytes(3).toString("hex")

const claim = await claimOwner(ownerId)
const isOwner = claim.owner

let eventCounter = 0
const emitBootstrap = async (text: string, level: EventLevel = "status") => {
	eventCounter += 1
	await appendEvent({
		id: `${Date.now()}-${process.pid}-bootstrap-${eventCounter}`,
		type: "line",
		sessionId: null,
		level,
		text,
		createdAt: new Date().toISOString(),
	})
}

function isAddrInUse(error: unknown): boolean {
	const msg = String((error as any)?.message ?? error ?? "")
	return (error as any)?.code === "EADDRINUSE" || msg.includes("EADDRINUSE") || msg.includes("Address already in use")
}

function listListeningPids(port: number): { pid: number; command: string }[] {
	const platform = process.platform
	let result: { exitCode: number; stdout: { toString(): string } }
	if (platform === "darwin") {
		result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"])
	} else {
		// Linux: use ss + parse, or fuser as fallback
		result = Bun.spawnSync(["fuser", `${port}/tcp`])
	}
	if (result.exitCode !== 0) return []
	const pids: number[] = []
	if (platform === "darwin") {
		for (const line of result.stdout.toString().split("\n")) {
			if (line.startsWith("p")) {
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
	return pids.filter(pid => pid !== process.pid).map(pid => {
		const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)])
		const command = ps.exitCode === 0 ? ps.stdout.toString().trim() : ""
		return { pid, command }
	})
}

function findSuspendedHalProcesses(port: number): { pid: number; command: string }[] {
	return listListeningPids(port).filter(({ pid, command }) => {
		const ps = Bun.spawnSync(["ps", "-o", "state=", "-p", String(pid)])
		const state = ps.exitCode === 0 ? ps.stdout.toString().trim() : ""
		const isSuspended = state.startsWith("T")
		const looksLikeHal = command.includes("bun main.ts") || command.includes("/bin/bash ./run")
		return isSuspended && looksLikeHal
	})
}

if (isOwner) {
	await resetBusEvents()
	if (fresh) await emitBootstrap(`[fresh] state dir: ${STATE_DIR}`)
	try {
		const web = startWebServer(webPort)
		await emitBootstrap(`[web] http://localhost:${web.port}`)
	} catch (e: any) {
		if (isAddrInUse(e)) {
			const suspended = findSuspendedHalProcesses(webPort)
			if (suspended.length > 0) {
				const pids = suspended.map(s => s.pid).join(", ")
				process.stdout.write(`\nPort ${webPort} held by suspended HAL process${suspended.length > 1 ? "es" : ""} (PID ${pids})\nKill and reclaim? [Y/n] `)
				const response = await new Promise<string>(resolve => {
					let buf = ""
					const onData = (chunk: Buffer) => {
						buf += chunk.toString()
						if (buf.includes("\n")) {
							process.stdin.removeListener("data", onData)
							process.stdin.pause()
							if ((process.stdin as any).setRawMode) (process.stdin as any).setRawMode(false)
							resolve(buf.trim())
						}
					}
					process.stdin.resume()
					process.stdin.on("data", onData)
				})
				if (!response || response.toLowerCase() === "y" || response.toLowerCase() === "yes") {
					for (const { pid } of suspended) {
						try { process.kill(pid, "SIGKILL") } catch {}
					}
					await Bun.sleep(200)
					try {
						const web = startWebServer(webPort)
						await emitBootstrap(`[web] http://localhost:${web.port} (reclaimed from PID ${pids})`)
					} catch (retryErr: any) {
						await emitBootstrap(`[web] disabled: ${retryErr.message || retryErr}`, "warn")
					}
				} else {
					await emitBootstrap(`[web] disabled: port ${webPort} in use`, "warn")
				}
			} else {
				await emitBootstrap(`[web] disabled: port ${webPort} in use by another process`, "warn")
			}
		} else {
			await emitBootstrap(`[web] disabled: ${e.message || e}`, "warn")
		}
	}

	startRuntime(ownerId).catch(async (e) => {
		await emitBootstrap(`[engine] crashed: ${e.message || e}`, "error")
		await releaseOwner(ownerId)
		process.exit(1)
	})
}

if (headless) {
	if (!isOwner) {
		await emitBootstrap("[runtime] --headless but not owner; exiting", "warn")
		process.exit(0)
	}
	await emitBootstrap("[runtime] headless mode", "status")
	const shutdown = async () => { await releaseOwner(ownerId); process.exit(0) }
	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)
	await new Promise(() => {})
} else {
	initClient({ kind: "cli", clientId }, isOwner)
	let exitCode = 0
	let exitingViaSigint = false

	process.on("SIGINT", () => {
		if (exitingViaSigint) return
		exitingViaSigint = true
		void (async () => {
			if (isOwner) await releaseOwner(ownerId)
			process.exit(100)
		})()
	})

	try {
		await startClient()
	} catch (e: any) {
		exitCode = 1
		await emitBootstrap(`[cli] crashed: ${e?.message || e}`, "error")
	}

	if (isOwner) await releaseOwner(ownerId)
	process.exit(exitCode)
}
