import { resolve } from "path"
import { loadConfig, resolveModel, providerForModel, modelIdForModel } from "../config.ts"
import { getProvider } from "../provider.ts"
import { loadSystemPrompt } from "../prompt.ts"
import {
	estimatedContextStatus,
	estimateMessageTokens,
	estimateTokensSync,
	getCalibration,
	MAX_CONTEXT,
} from "../context.ts"
import {
	loadSession,
	loadHandoff,
	loadSessionRegistry,
	makeSessionId,
	saveSessionRegistry,
	timeSince,
	type SessionRegistry,
	type TokenTotals,
	EMPTY_TOTALS,
} from "../session.ts"
import { tailCommands } from "../ipc.ts"
import type { SessionInfo } from "../protocol.ts"
import { HAL_DIR, LAUNCH_CWD, ensureStateDir, sessionDir } from "../state.ts"
import {
	createCommandScheduler,
	ensureSessionQueue,
	totalQueuedCommands,
} from "./command-scheduler.ts"
import { processCommand } from "./process-command.ts"
import { handleCommand } from "./handle-command.ts"
import {
	initPublisher,
	publishLine,
	publishStatus,
	publishSessions,
} from "./event-publisher.ts"

// Runtime cache per session
export interface SessionRuntimeCache {
	messages: any[]
	tokenTotals: TokenTotals
	lastUsage: any
	systemPrompt: any[]
	systemBytes: number
	pausedByUser: boolean
	activeAbort: AbortController | null
}

// Module state
let ownerId: string
let halDir: string
let _defaultWorkingDir: string

let registry: SessionRegistry = { activeSessionId: null, sessions: [] }
const sessionCache = new Map<string, SessionRuntimeCache>()
let activeSessionId: string | null = null
export const busySessions = new Set<string>()
export const previousWorkingDirBySession = new Map<string, string>()
export const lastCommandAtBySource = new Map<string, number>()

// Accessors
export function getOwnerId(): string { return ownerId }
export function getHalDir(): string { return halDir }
export function getDefaultWorkingDir(): string { return _defaultWorkingDir }
export function getActiveSessionId(): string | null { return activeSessionId }
export function setActiveSessionId(id: string | null): void { activeSessionId = id }
export function getRegistryActiveSessionId(): string | null { return registry.activeSessionId ?? null }
export function getFirstSessionId(): string | null { return registry.sessions[0]?.id ?? null }

export function getSessionWorkingDir(sessionId: string | null): string {
	return getSessionMeta(sessionId)?.workingDir ?? _defaultWorkingDir
}

export function hasSession(sessionId: string): boolean {
	return Boolean(getSessionMeta(sessionId))
}

export function isSessionBusy(sessionId: string): boolean {
	return busySessions.has(sessionId)
}

export function sortedBusySessionIds(): string[] {
	return [...busySessions].sort()
}

export function getCachedSessionRuntime(sessionId: string): SessionRuntimeCache | null {
	return sessionCache.get(sessionId) ?? null
}

export function getSessionCache(): Map<string, SessionRuntimeCache> {
	return sessionCache
}

export function markSessionAsActive(sessionId: string): void {
	activeSessionId = sessionId
	registry.activeSessionId = sessionId
}

export function sanitizeSessionId(sessionId: string): string {
	return sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, "_") || makeSessionId()
}

// Session management
export function getSessionMeta(sessionId: string | null): SessionInfo | null {
	if (!sessionId) return null
	return registry.sessions.find((s) => s.id === sessionId) ?? null
}

export function getRegistry(): SessionRegistry { return registry }

export async function persistRegistry(): Promise<void> {
	await saveSessionRegistry(registry)
}

export async function ensureSession(sessionId: string, workingDir: string): Promise<SessionInfo> {
	const cleanId = sanitizeSessionId(sessionId)
	let session = getSessionMeta(cleanId)
	if (session) return session

	session = {
		id: cleanId,
		name: undefined,
		workingDir: resolve(workingDir || _defaultWorkingDir),
		busy: false,
		messageCount: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}
	registry.sessions.push(session)
	if (!registry.activeSessionId) registry.activeSessionId = session.id
	ensureSessionQueue(session.id)
	await persistRegistry()
	await emitSessions(true)
	return session
}

export async function getOrLoadSessionRuntime(sessionId: string): Promise<SessionRuntimeCache> {
	const existing = sessionCache.get(sessionId)
	if (existing) return existing

	const restored = await loadSession(sessionId)
	let messages = restored?.messages ?? []
	if (messages.length === 0) {
		const handoff = await loadHandoff(sessionId)
		if (handoff) {
			messages = [{ role: "user", content: `[handoff]\n\n${handoff.trim()}` }]
		}
	}
	const runtime: SessionRuntimeCache = {
		messages,
		tokenTotals: { ...EMPTY_TOTALS, ...(restored?.tokenTotals ?? EMPTY_TOTALS) },
		lastUsage: null,
		systemPrompt: [],
		systemBytes: 0,
		pausedByUser: false,
		activeAbort: null,
	}
	sessionCache.set(sessionId, runtime)
	ensureSessionQueue(sessionId)
	await reloadSystemPromptForSession(sessionId, runtime)
	return runtime
}

export async function reloadSystemPromptForSession(sessionId: string, runtime?: SessionRuntimeCache): Promise<string[]> {
	const target = runtime ?? (await getOrLoadSessionRuntime(sessionId))
	const config = loadConfig()
	const modelId = modelIdForModel(config.model)
	const workingDir = getSessionWorkingDir(sessionId)
	const { blocks, systemBytes, loaded } = await loadSystemPrompt({ model: modelId, halDir, workingDir })
	target.systemPrompt = blocks
	target.systemBytes = systemBytes
	return loaded
}

// Event helpers
function snapshotSessions(): SessionInfo[] {
	return registry.sessions.map((s) => ({
		...s,
		busy: busySessions.has(s.id),
	}))
}

export async function emitStatus(force = false): Promise<void> {
	await publishStatus({
		busySessionIds: sortedBusySessionIds(),
		activeSessionId,
		registryActiveSessionId: registry.activeSessionId ?? null,
		queueLength: totalQueuedCommands(),
		sessions: snapshotSessions(),
	}, force)
}

export async function emitSessions(force = false): Promise<void> {
	await publishSessions(
		activeSessionId,
		registry.activeSessionId ?? null,
		snapshotSessions(),
		force,
	)
}

// Startup
async function initialize(): Promise<void> {
	ensureStateDir()

	registry = await loadSessionRegistry({ defaultWorkingDir: _defaultWorkingDir })

	let initialSessionId = registry.activeSessionId ?? registry.sessions[0]?.id ?? null
	if (!initialSessionId) {
		const created = await ensureSession(makeSessionId(), _defaultWorkingDir)
		initialSessionId = created.id
	}
	markSessionAsActive(initialSessionId)
	const runtime = await getOrLoadSessionRuntime(initialSessionId)
	await persistRegistry()
	await emitSessions(true)

	const cal = await getCalibration()
	const sysTokenEst = estimateTokensSync(runtime.systemBytes, cal)
	let msgTokens = 0
	for (const msg of runtime.messages) msgTokens += estimateMessageTokens(msg)

	if (runtime.messages.length > 0) {
		const totalTokens = sysTokenEst + msgTokens
		const pct = ((totalTokens / MAX_CONTEXT) * 100).toFixed(0)
		await publishLine(
			`[session] restored ${runtime.messages.length} messages (~${pct}% context)`,
			"status", initialSessionId,
		)
	} else {
		await publishLine(`[session] new session — ${sessionDir(initialSessionId)}`, "status", initialSessionId)
	}

	const config = loadConfig()
	const fullModel = resolveModel(config.model)
	const cwd = getSessionWorkingDir(initialSessionId)
	const loaded = await reloadSystemPromptForSession(initialSessionId, runtime)
	const promptDesc = loaded.length > 0 ? `  prompt=${loaded.join(", ")}` : ""
	await publishLine(
		`[model] ${fullModel}  cwd=${cwd}${promptDesc}`,
		"status", initialSessionId,
	)
	await publishLine(
		estimatedContextStatus(sysTokenEst, msgTokens, runtime.messages.length),
		"status", initialSessionId,
	)
	await emitStatus(true)
}

export async function startRuntime(
	owner: string,
	options: { defaultWorkingDir?: string; halDir?: string } = {},
): Promise<void> {
	ownerId = owner
	_defaultWorkingDir = resolve(options.defaultWorkingDir ?? LAUNCH_CWD)
	halDir = resolve(options.halDir ?? HAL_DIR)
	initPublisher(ownerId)

	const config = loadConfig()

	createCommandScheduler(
		config.maxConcurrentSessions,
		async (sessionId, command) => {
			markSessionAsActive(sessionId)
			await emitStatus(true)
			await handleCommand(command, sessionId)
			await emitStatus(true)
		},
		{
			onError: async (sessionId, error) => {
				await publishLine(
					`[scheduler] session ${sessionId} failed: ${(error as any)?.message || error}`,
					"error", sessionId,
				)
			},
			afterRun: async () => {
				await emitStatus(true)
			},
		},
	)

	await initialize()

	for await (const command of tailCommands()) {
		await processCommand(command)
	}
}
