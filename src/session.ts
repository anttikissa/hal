// See docs/session.md for architecture overview.

import { mkdir, readFile, writeFile, unlink, rename, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { stringify, parse } from './utils/ason.ts'
import { sessionDir, SESSIONS_DIR, SESSIONS_INDEX, ensureStateDir, LAUNCH_CWD } from './state.ts'
import { resolve } from 'path'

export type TokenTotals = { input: number; output: number; cacheCreate: number; cacheRead: number }
export const EMPTY_TOTALS: TokenTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }

export interface SessionInfo {
	id: string
	name?: string
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

function promptsPath(id: string): string {
	return `${sessionDir(id)}/prompts.ason`
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

export async function saveSession(
	sessionId: string,
	messages: any[],
	tokenTotals: TokenTotals,
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
}

export async function clearSession(sessionId: string): Promise<void> {
	const path = sessionPath(sessionId)
	if (existsSync(path)) await unlink(path)
}

const MAX_HISTORY = 200

export async function loadInputHistory(sessionId: string): Promise<string[]> {
	const path = `${sessionDir(sessionId)}/history.ason`
	if (!existsSync(path)) return []
	try {
		const raw = await readFile(path, 'utf-8')
		const data = parse(raw)
		return Array.isArray(data) ? data.slice(-MAX_HISTORY) : []
	} catch {
		return []
	}
}

export async function saveInputHistory(sessionId: string, history: string[]): Promise<void> {
	await ensureSessionDir(sessionId)
	await writeFile(
		`${sessionDir(sessionId)}/history.ason`,
		stringify(history.slice(-MAX_HISTORY)) + '\n',
	)
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

// Prompt logging

export async function logPrompt(
	sessionId: string,
	entry: {
		timestamp: string
		model: string
		provider: string
		prompt: string
	},
): Promise<void> {
	await ensureSessionDir(sessionId)
	const { $ } = await import('bun')
	let gitHash = ''
	try {
		gitHash = (await $`git rev-parse HEAD`.quiet().text()).trim().slice(0, 8)
	} catch {
		/* no git */
	}
	const record = { ...entry, gitHash }
	const { appendFile } = await import('fs/promises')
	await appendFile(promptsPath(sessionId), stringify(record) + '\n')
}

// Fork: copy session state to a new session
export async function forkSession(sourceId: string): Promise<string> {
	const newId = makeSessionId()
	const srcDir = sessionDir(sourceId)
	const dstDir = sessionDir(newId)
	await mkdir(dstDir, { recursive: true })

	// Copy session data and input history (not prompts — those are logs)
	for (const file of ['session.ason', 'history.ason']) {
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
