import { basename, resolve } from 'path'
import { watch, type FSWatcher } from 'fs'
import { loadConfig, resolveModel, modelIdForModel } from '../config.ts'
import { loadSystemPrompt } from '../system-prompt.ts'
import {
	estimateMessageTokens,
	estimateTokensSync,
	getCalibration,
	MAX_CONTEXT,
} from '../context.ts'
import {
	loadSession,
	loadHandoff,
	loadSessionRegistry,
	makeSessionId,
	saveSession,
	saveSessionRegistry,
	timeSince,
	type SessionRegistry,
	type TokenTotals,
	EMPTY_TOTALS,
} from '../session.ts'
import { tailCommands } from '../ipc.ts'
import type { SessionInfo } from '../protocol.ts'
import { HAL_DIR, LAUNCH_CWD, ensureStateDir, sessionDir } from '../state.ts'
import {
	createCommandScheduler,
	ensureSessionQueue,
	totalQueuedCommands,
	pausedSessionIds as getSchedulerPausedIds,
} from './command-scheduler.ts'
import { processCommand } from './process-command.ts'
import { handleCommand } from './handle-command.ts'
import { initPublisher, publishLine, publishStatus, publishSessions, publishContext } from './event-publisher.ts'

// Runtime cache per session
export interface SessionRuntimeCache {
	messages: any[]
	tokenTotals: TokenTotals
	lastUsage: any
	systemPrompt: any[]
	systemPromptFiles: string[]
	systemBytes: number
	pausedByUser: boolean
	activeAbort: AbortController | null
	/** In-progress content blocks during streaming (for fork snapshots) */
	streamingBlocks: any[] | null
	/** Has the first-response token log been shown for this session? */
	tokenLogShown: boolean
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
const _calibratedModels = new Set<string>()
export function calibrated(model: string | null): boolean {
	return !!model && _calibratedModels.has(model)
}
export function setCalibrated(model: string | null, value = true): void {
	if (!model) return
	if (value) _calibratedModels.add(model)
	else _calibratedModels.delete(model)
}


// Accessors
export function getOwnerId(): string {
	return ownerId
}
export function getHalDir(): string {
	return halDir
}
export function getDefaultWorkingDir(): string {
	return _defaultWorkingDir
}
export function getActiveSessionId(): string | null {
	return activeSessionId
}
export function setActiveSessionId(id: string | null): void {
	activeSessionId = id
}
export function getRegistryActiveSessionId(): string | null {
	return registry.activeSessionId ?? null
}
export function getFirstSessionId(): string | null {
	return registry.sessions[0]?.id ?? null
}

export function getSessionWorkingDir(sessionId: string | null): string {
	return getSessionMeta(sessionId)?.workingDir ?? _defaultWorkingDir
}

/** Resolve which model a session should use: per-session override or global default. */
export function getSessionModel(sessionId: string | null): string {
	const meta = getSessionMeta(sessionId)
	return resolveModel(meta?.model ?? loadConfig().model)
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
	return sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || makeSessionId()
}

// Session management
export function getSessionMeta(sessionId: string | null): SessionInfo | null {
	if (!sessionId) return null
	return registry.sessions.find((s) => s.id === sessionId) ?? null
}

export function getRegistry(): SessionRegistry {
	return registry
}

export async function persistRegistry(): Promise<void> {
	await saveSessionRegistry(registry)
}

/** Save all in-memory session state to disk. Called on shutdown. */
export async function saveAllSessions(): Promise<void> {
	for (const [id, runtime] of sessionCache) {
		await saveSession(id, runtime.messages, runtime.tokenTotals)
	}
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
			messages = [{ role: 'user', content: `[handoff]\n\n${handoff.trim()}` }]
		}
	}
	const runtime: SessionRuntimeCache = {
		messages,
		tokenTotals: { ...EMPTY_TOTALS, ...(restored?.tokenTotals ?? EMPTY_TOTALS) },
		lastUsage: null,
		systemPrompt: [],
		systemPromptFiles: [],
		systemBytes: 0,
		pausedByUser: false,
		activeAbort: null,
		streamingBlocks: null,
		tokenLogShown: false,
	}
	sessionCache.set(sessionId, runtime)
	ensureSessionQueue(sessionId)
	await reloadSystemPromptForSession(sessionId, runtime)

	// Emit context estimate so the statusline is populated immediately
	const cal = await getCalibration(getSessionModel(sessionId))
	const sysTokenEst = estimateTokensSync(runtime.systemBytes, cal)
	let msgTokens = 0
	for (const msg of messages) msgTokens += estimateMessageTokens(msg, cal)
	const used = sysTokenEst + msgTokens
	await publishContext(sessionId, { used, max: MAX_CONTEXT, estimated: true })

	return runtime
}

export async function reloadSystemPromptForSession(
	sessionId: string,
	runtime?: SessionRuntimeCache,
): Promise<string[]> {
	const target = runtime ?? (await getOrLoadSessionRuntime(sessionId))
	const fullModel = getSessionModel(sessionId)
	const modelId = modelIdForModel(fullModel)
	const workingDir = getSessionWorkingDir(sessionId)
	const { blocks, systemBytes, loaded, warnings } = await loadSystemPrompt({
		model: modelId,
		halDir,
		workingDir,
		sessionDir: sessionDir(sessionId),
	})
	target.systemPrompt = blocks
	target.systemPromptFiles = loaded
	target.systemBytes = systemBytes
	for (const w of warnings) await publishLine(`[error] ${w}`, 'error', sessionId)
	return loaded
}

/** Watch SYSTEM.md and AGENTS.md for changes; auto-reload system prompt. */
function watchSystemPromptFiles(): void {
	const files = new Map<string, FSWatcher>()
	let debounce: ReturnType<typeof setTimeout> | null = null
	const changedFiles = new Set<string>()

	const reload = async () => {
		const names = [...changedFiles]
		changedFiles.clear()
		for (const [id, runtime] of sessionCache) {
			await reloadSystemPromptForSession(id, runtime)
		}
		const sid = activeSessionId
		if (sid) {
			const label = names.length > 0 ? names.join(', ') : 'system prompt'
			await publishLine(`[system] reloaded ${label} (file changed)`, 'meta', sid)
			const runtime = sessionCache.get(sid)
			if (runtime) {
				const cal = await getCalibration(getSessionModel(sid))
				const sysTokenEst = estimateTokensSync(runtime.systemBytes, cal)
				let msgTokens = 0
				for (const msg of runtime.messages) msgTokens += estimateMessageTokens(msg, cal)
				await publishContext(sid, { used: sysTokenEst + msgTokens, max: MAX_CONTEXT, estimated: true })
			}
		}
	}

	const onChange = (filePath: string) => {
		changedFiles.add(basename(filePath))
		if (debounce) clearTimeout(debounce)
		debounce = setTimeout(() => void reload(), 150)
	}

	const tryWatch = (path: string) => {
		// Clean up previous watcher for this path
		files.get(path)?.close()
		try {
			const w = watch(path, { persistent: false }, () => onChange(path))
			files.set(path, w)
		} catch {
			// File doesn't exist (yet) — ignore
			files.delete(path)
		}
	}

	// Watch SYSTEM.md in halDir
	tryWatch(`${halDir}/SYSTEM.md`)

	// Watch AGENTS.md in each unique working dir
	const watchedAgentsDirs = new Set<string>()
	for (const s of registry.sessions) {
		const dir = s.workingDir ?? _defaultWorkingDir
		if (!watchedAgentsDirs.has(dir)) {
			watchedAgentsDirs.add(dir)
			tryWatch(`${dir}/AGENTS.md`)
		}
	}
}

// Event helpers
function snapshotSessions(): SessionInfo[] {
	return registry.sessions.map((s) => ({
		...s,
		busy: busySessions.has(s.id),
	}))
}

export async function emitStatus(force = false): Promise<void> {
	await publishStatus(
		{
			busySessionIds: sortedBusySessionIds(),
			pausedSessionIds: getSchedulerPausedIds(),
			activeSessionId,
			registryActiveSessionId: registry.activeSessionId ?? null,
			queueLength: totalQueuedCommands(),
			sessions: snapshotSessions(),
		},
		force,
	)
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

	if (runtime.messages.length > 0) {
		const cal = await getCalibration(getSessionModel(initialSessionId))
		const sysTokenEst = estimateTokensSync(runtime.systemBytes, cal)
		let msgTokens = 0
		for (const msg of runtime.messages) msgTokens += estimateMessageTokens(msg, cal)
		const totalTokens = sysTokenEst + msgTokens
		const pct = ((totalTokens / MAX_CONTEXT) * 100).toFixed(0)
		await publishLine(
			`[session] restored ${runtime.messages.length} messages (~${pct}% context) — ${sessionDir(initialSessionId)}`,
			'meta',
			initialSessionId,
		)
	} else {
		await publishLine(
			`[session] new session — ${sessionDir(initialSessionId)}`,
			'meta',
			initialSessionId,
		)
	}

	const fullModel = getSessionModel(initialSessionId)
	const cwd = getSessionWorkingDir(initialSessionId)
	// System prompt was already loaded by getOrLoadSessionRuntime — use cached file list
	const promptDesc = runtime.systemPromptFiles.length > 0
		? `  prompt=${runtime.systemPromptFiles.join(', ')}`
		: ''
	await publishLine(`[model] ${fullModel}  cwd=${cwd}${promptDesc}`, 'meta', initialSessionId)
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
					'error',
					sessionId,
				)
			},
			afterRun: async () => {
				await emitStatus(true)
			},
		},
	)

	await initialize()
	watchSystemPromptFiles()

	for await (const command of tailCommands()) {
		await processCommand(command)
	}
}
