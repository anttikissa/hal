// See docs/session.md — keep it in sync when changing this file.

import { appendFile, mkdir, readFile, writeFile, unlink, rename, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { stringify, parse, parseAll } from './utils/ason.ts'
import { sessionDir, SESSIONS_DIR, SESSIONS_INDEX, ensureStateDir, LAUNCH_CWD } from './state.ts'
import { resolve } from 'path'

export type TokenTotals = { input: number; output: number; cacheCreate: number; cacheRead: number }
export const EMPTY_TOTALS: TokenTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }

export interface SessionInfo {
	id: string
	name?: string
	topic?: string
	model?: string // per-session model override; falls back to global config
	workingDir: string
	busy: boolean
	messageCount: number
	createdAt: string
	updatedAt: string
}

export interface SessionRegistry {
	activeSessionId: string | null
	sessions: SessionInfo[]
}

interface SessionFile {
	messages: any[]
	tokenTotals: TokenTotals
	createdAt: string
	updatedAt: string
}

export function makeSessionId(): string {
	return `s-${randomBytes(3).toString('hex')}`
}

function nowIso(): string {
	return new Date().toISOString()
}

function sanitizeSessionId(id: string): string {
	return id.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 's-default'
}

function sessionPath(id: string): string {
	return `${sessionDir(id)}/session.ason`
}

function sessionPreviousPath(id: string): string {
	return `${sessionDir(id)}/session-previous.ason`
}

function handoffPath(id: string): string {
	return `${sessionDir(id)}/handoff.md`
}

function infoPath(id: string): string {
	return `${sessionDir(id)}/info.ason`
}

function conversationPath(id: string): string {
	return `${sessionDir(id)}/conversation.ason`
}

// Session info (persisted per-session metadata)

export interface SessionMeta {
	workingDir: string
	model?: string
	topic?: string
	updatedAt: string
	lastPrompt?: string
}

export async function saveSessionInfo(id: string, meta: SessionMeta): Promise<void> {
	await ensureSessionDir(id)
	await writeFile(infoPath(id), stringify(meta) + '\n')
}

export async function loadSessionInfo(id: string): Promise<SessionMeta | null> {
	// Try info.ason first, fall back to legacy meta.ason
	for (const path of [infoPath(id), `${sessionDir(id)}/meta.ason`]) {
		if (!existsSync(path)) continue
		try {
			return parse(await readFile(path, 'utf-8')) as SessionMeta
		} catch {
			continue
		}
	}
	return null
}

// Conversation event log

export type ConversationEvent =
	| { type: 'user'; text: string; ts: string }
	| { type: 'assistant'; text: string; ts: string }
	| { type: 'model'; from: string; to: string; ts: string }
	| { type: 'fork'; parent: string; child: string; ts: string }
	| { type: 'topic'; from?: string; to: string; auto?: boolean; ts: string }
	| { type: 'handoff'; ts: string }
	| { type: 'reset'; ts: string }
	| { type: 'cd'; from: string; to: string; ts: string }

export async function appendConversation(sessionId: string, event: ConversationEvent): Promise<void> {
	await ensureSessionDir(sessionId)
	await appendFile(conversationPath(sessionId), stringify(event, 'short') + '\n')
}

export async function loadConversation(sessionId: string): Promise<ConversationEvent[]> {
	const path = conversationPath(sessionId)
	if (!existsSync(path)) return []
	try {
		return parseAll(await readFile(path, 'utf-8')) as ConversationEvent[]
	} catch {
		return []
	}
}

// Input history derived from conversation events
export async function loadInputHistory(sessionId: string): Promise<string[]> {
	const events = await loadConversation(sessionId)
	return events
		.filter((e): e is ConversationEvent & { type: 'user' } => e.type === 'user')
		.map((e) => e.text)
		.slice(-200)
}

// Draft persistence (unsent prompt text)

function draftPath(id: string): string {
	return `${sessionDir(id)}/draft.txt`
}

export async function saveDraft(sessionId: string, text: string): Promise<void> {
	if (!text) {
		const path = draftPath(sessionId)
		if (existsSync(path)) await unlink(path)
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

async function ensureSessionDir(id: string): Promise<void> {
	const dir = sessionDir(id)
	if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

function createSessionInfo(id: string, workingDir: string): SessionInfo {
	const ts = nowIso()
	return {
		id: sanitizeSessionId(id),
		workingDir: resolve(workingDir),
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

	if (!existsSync(SESSIONS_INDEX)) {
		const session = createSessionInfo('s-default', defaultWorkingDir)
		const registry: SessionRegistry = { activeSessionId: session.id, sessions: [session] }
		await saveSessionRegistry(registry)
		return registry
	}

	try {
		const raw = await readFile(SESSIONS_INDEX, 'utf-8')
		const parsed = parse(raw) as Partial<SessionRegistry>
		const sessions = Array.isArray(parsed.sessions)
			? parsed.sessions.filter((s: any) => s?.id).map((s: any) => ({ ...s, busy: false }))
			: []
		if (sessions.length === 0) {
			const session = createSessionInfo('s-default', defaultWorkingDir)
			const registry: SessionRegistry = { activeSessionId: session.id, sessions: [session] }
			await saveSessionRegistry(registry)
			return registry
		}
		const activeSessionId =
			typeof parsed.activeSessionId === 'string' &&
			sessions.some((s: any) => s.id === parsed.activeSessionId)
				? parsed.activeSessionId
				: sessions[0].id
		return { activeSessionId, sessions }
	} catch {
		const session = createSessionInfo('s-default', defaultWorkingDir)
		const registry: SessionRegistry = { activeSessionId: session.id, sessions: [session] }
		await saveSessionRegistry(registry)
		return registry
	}
}

export async function saveSessionRegistry(registry: SessionRegistry): Promise<void> {
	ensureStateDir()
	await writeFile(SESSIONS_INDEX, stringify(registry) + '\n')
}

// Session load/save

export async function loadSession(
	sessionId: string,
): Promise<{ messages: any[]; tokenTotals: TokenTotals } | null> {
	const path = sessionPath(sessionId)
	if (!existsSync(path)) return null
	try {
		const raw = await readFile(path, 'utf-8')
		const session: SessionFile = parse(raw)
		if (!Array.isArray(session.messages) || session.messages.length === 0) return null
		const messages = repairMessages(session.messages)
		return { messages, tokenTotals: session.tokenTotals ?? { ...EMPTY_TOTALS } }
	} catch {
		return null
	}
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

export async function saveSession(
	sessionId: string,
	messages: any[],
	tokenTotals: TokenTotals,
	meta?: Omit<SessionMeta, 'updatedAt' | 'lastPrompt'>,
): Promise<void> {
	await ensureSessionDir(sessionId)
	const path = sessionPath(sessionId)
	const now = nowIso()
	let createdAt = now
	try {
		if (existsSync(path)) {
			const existing = parse(await readFile(path, 'utf-8'))
			if (existing.createdAt) createdAt = existing.createdAt
		}
	} catch {
		/* use now */
	}
	const session: SessionFile = { messages, tokenTotals, createdAt, updatedAt: now }
	await writeFile(path, stringify(session) + '\n')
	if (meta) {
		await saveSessionInfo(sessionId, {
			...meta,
			updatedAt: now,
			lastPrompt: extractLastPrompt(messages),
		})
	}
}

export async function clearSession(sessionId: string): Promise<void> {
	const path = sessionPath(sessionId)
	if (existsSync(path)) await unlink(path)
}

// Handoff

export async function performHandoff(sessionId: string, handoffContent: string): Promise<void> {
	await ensureSessionDir(sessionId)
	const sessPath = sessionPath(sessionId)
	const prevPath = sessionPreviousPath(sessionId)
	const hPath = handoffPath(sessionId)

	// Write handoff.md
	await writeFile(hPath, handoffContent)

	// Rotate session.ason → session-previous.ason
	if (existsSync(sessPath)) {
		if (existsSync(prevPath)) await unlink(prevPath)
		await rename(sessPath, prevPath)
	}
}

export async function loadHandoff(sessionId: string): Promise<string | null> {
	const hPath = handoffPath(sessionId)
	if (!existsSync(hPath)) return null
	try {
		const content = await readFile(hPath, 'utf-8')
		// Preserve for debugging, then remove
		const prevPath = `${sessionDir(sessionId)}/handoff-previous.md`
		await rename(hPath, prevPath)
		return content
	} catch {
		return null
	}
}

// Fork: copy session state to a new session
export async function forkSession(sourceId: string): Promise<string> {
	const newId = makeSessionId()
	const srcDir = sessionDir(sourceId)
	const dstDir = sessionDir(newId)
	await mkdir(dstDir, { recursive: true })

	for (const file of ['session.ason', 'conversation.ason']) {
		const src = `${srcDir}/${file}`
		if (existsSync(src)) await copyFile(src, `${dstDir}/${file}`)
	}

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
			// Drop thinking blocks without signatures (incomplete from interrupted generation)
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
