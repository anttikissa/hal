// See docs/session.md — keep it in sync when changing this file.

import { appendFile, mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { stringify, parse, parseAll } from './utils/ason.ts'
import { sessionDir, SESSIONS_INDEX, EPOCH_PATH, ensureStateDir, LAUNCH_CWD } from './state.ts'
import { resolve } from 'path'
import { getConfig } from './config.ts'

export type TokenTotals = { input: number; output: number; cacheCreate: number; cacheRead: number }
export const EMPTY_TOTALS: TokenTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }

export interface SessionInfo {
	id: string
	name?: string
	topic?: string
	model?: string
	workingDir: string
	busy: boolean
	messageCount: number
	createdAt: string
	updatedAt: string
	lastPrompt?: string
	tokenTotals?: TokenTotals
	currentLog: string
}

export interface SessionRegistry {
	activeSessionId: string | null
	sessions: SessionInfo[]
}

// Epoch: written once on first run, used for DD-xxx session IDs
let _epoch: Date | null = null

export async function ensureEpoch(): Promise<Date> {
	if (_epoch) return _epoch
	ensureStateDir()
	if (existsSync(EPOCH_PATH)) {
		_epoch = new Date((await readFile(EPOCH_PATH, 'utf-8')).trim())
	} else {
		_epoch = new Date()
		await writeFile(EPOCH_PATH, _epoch.toISOString() + '\n')
	}
	return _epoch
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

function generateId(epoch: Date, suffixLen: number): string {
	const dd = String(Math.max(0, Math.floor((Date.now() - epoch.getTime()) / 86_400_000))).padStart(2, '0')
	const bytes = randomBytes(suffixLen)
	let suffix = ''
	for (let i = 0; i < suffixLen; i++) suffix += ID_CHARS[bytes[i] % ID_CHARS.length]
	return `${dd}-${suffix}`
}

export async function makeSessionId(): Promise<string> {
	const epoch = await ensureEpoch()
	for (let i = 0; i < 10; i++) {
		const id = generateId(epoch, 3)
		if (!existsSync(sessionDir(id))) return id
	}
	return generateId(epoch, 4)
}

// Paths

function infoPath(id: string): string {
	return `${sessionDir(id)}/info.ason`
}

function blocksDir(id: string): string {
	return `${sessionDir(id)}/blocks`
}

function draftPath(id: string): string {
	return `${sessionDir(id)}/draft.txt`
}

async function ensureSessionDir(id: string): Promise<void> {
	const dir = sessionDir(id)
	if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

async function ensureBlocksDir(id: string): Promise<void> {
	const dir = blocksDir(id)
	if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

// Block storage

export function makeBlockRef(sessionId: string): string {
	const session = sessionInfoMap.get(sessionId)
	const start = session ? new Date(session.createdAt).getTime() : Date.now()
	const offset = Math.max(0, Date.now() - start).toString(36).padStart(6, '0')
	const bytes = randomBytes(4)
	let suffix = ''
	for (let i = 0; i < 4; i++) suffix += ID_CHARS[bytes[i] % ID_CHARS.length]
	return `${offset}-${suffix}`
}

export async function writeBlock(sessionId: string, ref: string, data: any): Promise<void> {
	await ensureBlocksDir(sessionId)
	await writeFile(`${blocksDir(sessionId)}/${ref}.ason`, stringify(data) + '\n')
}

export async function readBlock(sessionId: string, ref: string): Promise<any | null> {
	const path = `${blocksDir(sessionId)}/${ref}.ason`
	if (existsSync(path)) {
		try {
			return parse(await readFile(path, 'utf-8'))
		} catch {
			return null
		}
	}
	// Walk fork chain — block may live in parent's blocks/
	const parent = getParentSessionId(sessionId)
	if (parent) return readBlock(parent, ref)
	return null
}

// Fork chain resolution

const parentCache = new Map<string, string | null>()

function getParentSessionId(sessionId: string): string | null {
	const cached = parentCache.get(sessionId)
	if (cached !== undefined) return cached
	const path = `${sessionDir(sessionId)}/messages.asonl`
	if (!existsSync(path)) { parentCache.set(sessionId, null); return null }
	try {
		const raw = readFileSync(path, 'utf-8')
		const firstLine = raw.split('\n', 1)[0]
		if (!firstLine?.trim()) { parentCache.set(sessionId, null); return null }
		const entry = parse(firstLine) as any
		if (entry?.type === 'forked_from' && entry.parent) {
			parentCache.set(sessionId, entry.parent)
			return entry.parent
		}
	} catch {}
	parentCache.set(sessionId, null)
	return null
}
// Log I/O

function countWords(text: string): number {
	return text.split(/\s+/).filter(Boolean).length
}

export function appendToLog(sessionId: string, entries: any[]): Promise<void> {
	if (entries.length === 0) return Promise.resolve()
	const logName = sessionInfoMap.get(sessionId)?.currentLog ?? 'messages.asonl'
	const path = `${sessionDir(sessionId)}/${logName}`
	const lines = entries.map((e: any) => stringify(e, 'short')).join('\n') + '\n'
	return ensureSessionDir(sessionId).then(() => appendFile(path, lines))
}

/** Convert API-format assistant content blocks to a log entry, writing block files. */
export async function writeAssistantEntry(
	sessionId: string,
	contentBlocks: any[],
): Promise<{ entry: any; toolRefMap: Map<string, string> }> {
	const ts = new Date().toISOString()
	const entry: any = { role: 'assistant', ts }
	const toolRefMap = new Map<string, string>()

	const text = contentBlocks
		.filter((b: any) => b.type === 'text')
		.map((b: any) => b.text)
		.join('\n')
	if (text) entry.text = text

	const thinking = contentBlocks.find((b: any) => b.type === 'thinking')
	if (thinking?.thinking) {
		const ref = makeBlockRef(sessionId)
		await writeBlock(sessionId, ref, { thinking: thinking.thinking, signature: thinking.signature })
		entry.thinking = { ref, words: countWords(thinking.thinking) }
	}

	const tools = contentBlocks.filter((b: any) => b.type === 'tool_use')
	if (tools.length > 0) {
		entry.tools = []
		for (const t of tools) {
			const ref = makeBlockRef(sessionId)
			toolRefMap.set(t.id, ref)
			await writeBlock(sessionId, ref, { call: { name: t.name, input: t.input } })
			entry.tools.push({ id: t.id, name: t.name, ref })
		}
	}

	return { entry, toolRefMap }
}

/** Write tool result to block file and return log entry. */
export async function writeToolResultEntry(
	sessionId: string,
	toolUseId: string,
	output: string,
	toolRefMap: Map<string, string>,
): Promise<any> {
	const ref = toolRefMap.get(toolUseId)
	if (ref) {
		const existing = await readBlock(sessionId, ref)
		if (existing) {
			existing.result = { content: output }
			await writeBlock(sessionId, ref, existing)
		}
	}
	return { role: 'tool_result', tool_use_id: toolUseId, ref, ts: new Date().toISOString() }
}

/** Convert user content to log format: images → block refs. */
export async function userContentToLog(sessionId: string, content: any): Promise<any> {
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return content

	const logContent: any[] = []
	for (const block of content) {
		if (block.type === 'image' && block.source?.type === 'base64') {
			const ref = makeBlockRef(sessionId)
			await writeBlock(sessionId, ref, { media_type: block.source.media_type, data: block.source.data })
			logContent.push({ type: 'image', ref })
		} else {
			logContent.push(block)
		}
	}
	return logContent
}

// Canonical in-memory store — the one source of truth for session info
// Canonical in-memory store — the one source of truth for session info
export const sessionInfoMap = new Map<string, SessionInfo>()

export function getSessionInfo(id: string): SessionInfo | null {
	return sessionInfoMap.get(id) ?? null
}

/** Persist in-memory SessionInfo to disk. Strips transient fields (busy, messageCount). */
export async function saveSessionInfo(id: string): Promise<void> {
	const session = sessionInfoMap.get(id)
	if (!session) return
	await ensureSessionDir(id)
	const { busy, messageCount, ...disk } = session
	await writeFile(infoPath(id), stringify(disk) + '\n')
}

/** Read info.ason from disk (for startup hydration). */
export async function loadSessionInfo(id: string): Promise<Partial<SessionInfo> | null> {
	const path = infoPath(id)
	if (!existsSync(path)) return null
	try {
		return parse(await readFile(path, 'utf-8')) as Partial<SessionInfo>
	} catch {
		return null
	}
}
// Session load (API messages)

/** Load all log entries from all log files of a session, following fork references. */
async function loadAllEntries(sessionId: string): Promise<any[]> {
	const dir = sessionDir(sessionId)
	const allEntries: any[] = []

	// Read messages.asonl
	let firstEntries: any[] = []
	const first = `${dir}/messages.asonl`
	if (existsSync(first)) {
		try {
			const raw = await readFile(first, 'utf-8')
			if (raw.trim()) firstEntries = parseAll(raw) as any[]
		} catch {}
	}

	// Follow fork reference: load parent history, skip the forked_from entry
	if (firstEntries.length > 0 && firstEntries[0].type === 'forked_from') {
		const { parent, ts: forkTs } = firstEntries[0]
		const parentEntries = await loadAllEntries(parent)
		allEntries.push(...parentEntries.filter((e: any) => !e.ts || e.ts <= forkTs))
		allEntries.push(...firstEntries.slice(1))
	} else {
		allEntries.push(...firstEntries)
	}

	// Read messages2.asonl, messages3.asonl, etc.
	for (let n = 2; ; n++) {
		const path = `${dir}/messages${n}.asonl`
		if (!existsSync(path)) break
		try {
			const raw = await readFile(path, 'utf-8')
			if (raw.trim()) allEntries.push(...(parseAll(raw) as any[]))
		} catch {}
	}

	return allEntries
}

/** Find the index after the last handoff/reset event, or 0. */
function findReplayStart(entries: any[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === 'handoff' || entries[i].type === 'reset') return i + 1
	}
	return 0
}

/** Load session as API messages, applying context trimming. Also hydrates sessionInfoMap from info.ason. */
export async function loadSession(
	sessionId: string,
): Promise<{ messages: any[]; tokenTotals: TokenTotals } | null> {
	// Hydrate in-memory session info from disk
	const diskInfo = await loadSessionInfo(sessionId)
	const session = sessionInfoMap.get(sessionId)
	if (diskInfo && session) {
		if (diskInfo.tokenTotals) session.tokenTotals = diskInfo.tokenTotals
		if (diskInfo.lastPrompt) session.lastPrompt = diskInfo.lastPrompt
		if (diskInfo.currentLog) session.currentLog = diskInfo.currentLog
	}

	const allEntries = await loadAllEntries(sessionId)

	if (allEntries.length > 0) {
		const startIdx = findReplayStart(allEntries)
		const entries = allEntries.slice(startIdx)
		const messages = await entriesToApiMessages(sessionId, entries)
		return {
			messages: repairMessages(messages),
			tokenTotals: session?.tokenTotals ?? { ...EMPTY_TOTALS },
		}
	}

	return null
}

/** Convert log entries to API messages with context trimming. */
async function entriesToApiMessages(sessionId: string, entries: any[]): Promise<any[]> {
	const messages: any[] = []
	const recentToolResults = getConfig().recentToolResults

	// Count tool results for trimming
	const roleEntries = entries.filter((e: any) => e.role)
	let totalToolResults = 0
	for (const e of roleEntries) {
		if (e.role === 'tool_result') totalToolResults++
	}
	const trimThreshold = totalToolResults - recentToolResults

	// Find last user message index for image trimming
	let lastUserIdx = -1
	for (let i = roleEntries.length - 1; i >= 0; i--) {
		if (roleEntries[i].role === 'user') { lastUserIdx = i; break }
	}

	let toolResultIdx = 0
	for (let i = 0; i < roleEntries.length; i++) {
		const entry = roleEntries[i]

		if (entry.role === 'user') {
			const content = await resolveUserContent(sessionId, entry.content, i === lastUserIdx)
			messages.push({ role: 'user', content })
		} else if (entry.role === 'assistant') {
			const content = await resolveAssistantContent(sessionId, entry)
			if (content.length > 0) messages.push({ role: 'assistant', content })
		} else if (entry.role === 'tool_result') {
			const resultContent = toolResultIdx < trimThreshold
				? '[tool result omitted — run the tool again if needed]'
				: await resolveToolResult(sessionId, entry.ref)
			const resultBlock = { type: 'tool_result', tool_use_id: entry.tool_use_id, content: resultContent }

			// Group consecutive tool results into single user message
			const lastMsg = messages[messages.length - 1]
			if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content) && lastMsg.content[0]?.type === 'tool_result') {
				lastMsg.content.push(resultBlock)
			} else {
				messages.push({ role: 'user', content: [resultBlock] })
			}
			toolResultIdx++
		}
	}

	return messages
}

async function resolveUserContent(sessionId: string, content: any, isLastUser: boolean): Promise<any> {
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return content

	const resolved: any[] = []
	for (const block of content) {
		if (block.type === 'image' && block.ref) {
			if (isLastUser) {
				const data = await readBlock(sessionId, block.ref)
				if (data) {
					resolved.push({
						type: 'image',
						source: { type: 'base64', media_type: data.media_type, data: data.data },
					})
					continue
				}
			}
			resolved.push({ type: 'text', text: '[image omitted — use the read tool to view the file if needed]' })
		} else {
			resolved.push(block)
		}
	}
	return resolved
}

async function resolveAssistantContent(sessionId: string, entry: any): Promise<any[]> {
	const content: any[] = []

	if (entry.thinking?.ref) {
		const block = await readBlock(sessionId, entry.thinking.ref)
		if (block) {
			content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature })
		}
	}

	if (entry.text) content.push({ type: 'text', text: entry.text })

	if (entry.tools) {
		for (const tool of entry.tools) {
			const block = await readBlock(sessionId, tool.ref)
			content.push({
				type: 'tool_use',
				id: tool.id,
				name: tool.name,
				input: block?.call?.input ?? {},
			})
		}
	}

	return content
}

async function resolveToolResult(sessionId: string, ref: string): Promise<string> {
	if (!ref) return ''
	const data = await readBlock(sessionId, ref)
	return data?.result?.content ?? ''
}

// TUI replay

/** Load entries for TUI replay (truncated at last handoff/reset, thinking resolved). */
export async function loadReplayEntries(sessionId: string): Promise<any[]> {
	const allEntries = await loadAllEntries(sessionId)

	if (allEntries.length === 0) return []

	const startIdx = findReplayStart(allEntries)
	const entries = allEntries.slice(startIdx)

	const toolResults = new Map<string, string>()
	for (const entry of entries) {
		if (entry.role !== 'tool_result' || typeof entry.tool_use_id !== 'string') continue
		toolResults.set(entry.tool_use_id, await resolveToolResult(sessionId, entry.ref))
	}

	for (const entry of entries) {
		if (entry.role !== 'assistant') continue
		if (entry.thinking?.ref) {
			const block = await readBlock(sessionId, entry.thinking.ref)
			if (block) entry._thinkingText = block.thinking
		}
		if (Array.isArray(entry.tools) && entry.tools.length > 0) {
			const calls: any[] = []
			for (const tool of entry.tools) {
				const block = await readBlock(sessionId, tool.ref)
				calls.push({
					id: tool.id,
					name: tool.name,
					input: block?.call?.input ?? {},
					result: toolResults.get(tool.id) ?? '',
				})
			}
			entry._toolCalls = calls
		}
	}

	return entries
}

// Input history derived from log entries

export async function loadInputHistory(sessionId: string): Promise<string[]> {
	const entries = await loadAllEntries(sessionId)
	if (entries.length === 0) return []
	return entries
		.filter((e: any) => e.role === 'user')
		.map((e: any) => {
			if (typeof e.content === 'string') return e.content
			if (Array.isArray(e.content)) return e.content.find((b: any) => b.type === 'text')?.text ?? ''
			return ''
		})
		.filter((text: string) => text && !text.startsWith('['))
		.slice(-200)
}

// Draft persistence (unsent prompt text)

export async function saveDraft(sessionId: string, text: string): Promise<void> {
	if (!text) {
		const path = draftPath(sessionId)
		if (existsSync(path)) {
			await unlink(path)
		}
		return
	}
	await ensureSessionDir(sessionId)
	await writeFile(draftPath(sessionId), text)
}

export async function loadDraft(sessionId: string): Promise<string> {
	const path = draftPath(sessionId)
	if (!existsSync(path)) return ''
	try {
		return await readFile(path, 'utf-8')
	} catch {
		return ''
	}
}

function createSessionInfo(id: string, workingDir: string): SessionInfo {
	const ts = new Date().toISOString()
	return {
		id,
		workingDir: resolve(workingDir),
		currentLog: 'messages.asonl',
		busy: false,
		messageCount: 0,
		createdAt: ts,
		updatedAt: ts,
	}
}

// Registry

export async function loadSessionRegistry(
	options: { defaultWorkingDir?: string } = {},
): Promise<SessionRegistry> {
	const defaultWorkingDir = resolve(options.defaultWorkingDir ?? LAUNCH_CWD)
	ensureStateDir()

	async function defaultRegistry(): Promise<SessionRegistry> {
		const id = await makeSessionId()
		const session = createSessionInfo(id, defaultWorkingDir)
		sessionInfoMap.set(id, session)
		const registry: SessionRegistry = { activeSessionId: session.id, sessions: [session] }
		await saveSessionRegistry(registry)
		return registry
	}

	if (!existsSync(SESSIONS_INDEX)) return defaultRegistry()

	try {
		const raw = await readFile(SESSIONS_INDEX, 'utf-8')
		const parsed = parse(raw) as Partial<SessionRegistry>
		const sessions = Array.isArray(parsed.sessions)
			? parsed.sessions.filter((s: any) => s?.id).map((s: any) => ({
				...s,
				busy: false,
				messageCount: s.messageCount ?? 0,
			} as SessionInfo))
			: []
		if (sessions.length === 0) return defaultRegistry()
		for (const s of sessions) {
			const disk = await loadSessionInfo(s.id)
			if (disk) Object.assign(s, disk)
			s.busy = false
			sessionInfoMap.set(s.id, s)
		}
		const activeSessionId =
			typeof parsed.activeSessionId === 'string' &&
			sessions.some((s: any) => s.id === parsed.activeSessionId)
				? parsed.activeSessionId
				: sessions[0].id
		return { activeSessionId, sessions }
	} catch {
		return defaultRegistry()
	}
}

// Fields to include in the registry index (UI-relevant only)
const REGISTRY_FIELDS = new Set(['id', 'name', 'topic', 'model', 'workingDir', 'createdAt', 'updatedAt', 'messageCount'])

export async function saveSessionRegistry(registry: SessionRegistry): Promise<void> {
	ensureStateDir()
	const slim = {
		activeSessionId: registry.activeSessionId,
		sessions: registry.sessions.map(s => {
			const entry: Record<string, any> = {}
			for (const key of REGISTRY_FIELDS) {
				const val = (s as any)[key]
				if (val !== undefined) entry[key] = val
			}
			return entry
		}),
	}
	await writeFile(SESSIONS_INDEX, stringify(slim) + '\n')
}

// Rotation

/** Rotate: update currentLog so new entries go to a fresh file. */
export async function rotateSession(sessionId: string): Promise<number> {
	const session = sessionInfoMap.get(sessionId)
	const currentLog = session?.currentLog ?? 'messages.asonl'
	const currentPath = `${sessionDir(sessionId)}/${currentLog}`
	if (!existsSync(currentPath)) return 0

	let nextN = 2
	if (currentLog !== 'messages.asonl') {
		const match = currentLog.match(/^messages(\d+)\.asonl$/)
		if (match) nextN = parseInt(match[1], 10) + 1
	}

	if (session) session.currentLog = `messages${nextN}.asonl`
	await saveSessionInfo(sessionId)

	return nextN
}

/** Build deterministic context injection from user prompts for post-rotation. */
export function buildRotationContext(sessionId: string, messages: any[]): string {
	const userPrompts: string[] = []
	for (const msg of messages) {
		if (msg.role !== 'user') continue
		const text = typeof msg.content === 'string' ? msg.content : ''
		if (!text || text.startsWith('[')) continue
		userPrompts.push(text.split('\n')[0].slice(0, 200))
	}

	const dir = sessionDir(sessionId)

	if (userPrompts.length === 0) return `Session context was purged to avoid exceeding the token limit. No user prompts in previous session. Complete session history is at ${dir}/messages*.asonl + blocks/`

	const lines: string[] = [
		'Session context was purged to avoid exceeding the token limit. Be nice to the user — they might remember the context better than you do. On the other hand, they may have moved on to something else entirely and forgotten the details. Either way, verify before assuming.',
		'',
		"Here's some message history from the previous session:",
		'',
	]

	if (userPrompts.length <= 20) {
		lines.push('User messages:')
		userPrompts.forEach((p, i) => lines.push(`${i + 1}. ${p}`))
	} else {
		lines.push('First 10 user messages:')
		userPrompts.slice(0, 10).forEach((p, i) => lines.push(`${i + 1}. ${p}`))
		lines.push('')
		lines.push('Last 10 user messages:')
		const start = userPrompts.length - 10
		userPrompts.slice(-10).forEach((p, i) => lines.push(`${start + i + 1}. ${p}`))
	}

	lines.push('')
	lines.push(`If these are enough to remember what you were doing, feel free to continue after verifying with the user. If needed, the complete session history is at ${dir}/messages*.asonl + blocks/`)

	return lines.join('\n')
}

// Fork: reference parent session instead of copying

export async function forkSession(sourceId: string): Promise<string> {
	const newId = await makeSessionId()
	await mkdir(sessionDir(newId), { recursive: true })
	await appendToLog(newId, [{ type: 'forked_from', parent: sourceId, ts: new Date().toISOString() }])
	return newId
}

// Repair

function repairMessages(messages: any[]): any[] {
	const toolUseIds = new Set<string>()
	for (const msg of messages) {
		if (msg.role === 'assistant' && Array.isArray(msg.content)) {
			for (const b of msg.content) {
				if (b.type === 'tool_use' && b.id) toolUseIds.add(b.id)
			}
		}
	}
	const result: any[] = []
	for (const msg of messages) {
		if (msg.role === 'user' && Array.isArray(msg.content)) {
			const filtered = msg.content.filter((b: any) => {
				if (b.type === 'tool_result' && b.tool_use_id && !toolUseIds.has(b.tool_use_id))
					return false
				return true
			})
			if (filtered.length > 0) result.push({ ...msg, content: filtered })
		} else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
			const filtered = msg.content.filter((b: any) => {
				if (b.type === 'thinking' && !b.signature) return false
				return true
			})
			if (filtered.length > 0) result.push({ ...msg, content: filtered })
		} else {
			result.push(msg)
		}
	}
	return result
}

/** Extract the last user prompt text from messages (skipping internal markers). */
export function extractLastPrompt(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.role !== 'user') continue
		const content = typeof msg.content === 'string'
			? msg.content
			: Array.isArray(msg.content)
				? msg.content.find((b: any) => b.type === 'text')?.text ?? ''
				: ''
		if (!content || content.startsWith('[')) continue
		return content.split('\n')[0].slice(0, 120)
	}
	return ''
}

export function timeSince(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime()
	const seconds = Math.floor(diff / 1000)
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	return `${Math.floor(hours / 24)}d ago`
}