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

if (isOwner) {
	await resetBusEvents()
	if (fresh) await emitBootstrap(`[fresh] state dir: ${STATE_DIR}`)
	try {
		const web = startWebServer(webPort)
		await emitBootstrap(`[web] http://localhost:${web.port}`)
	} catch (e: any) {
		await emitBootstrap(`[web] disabled: ${e.message || e}`, "warn")
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
