// See docs/session.md — keep it in sync when changing this file.

import { appendFile, mkdir, readFile, writeFile, rename, copyFile, readdir } from 'fs/promises'
import { existsSync, readdirSync } from 'fs'
import { randomBytes } from 'crypto'
import { stringify, parse, parseAll } from './utils/ason.ts'
import { sessionDir, SESSIONS_DIR, SESSIONS_INDEX, EPOCH_PATH, ensureStateDir, LAUNCH_CWD } from './state.ts'
import { resolve } from 'path'

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

function sessionPath(id: string): string {
	return `${sessionDir(id)}/session.asonl`
}

function infoPath(id: string): string {
	return `${sessionDir(id)}/info.ason`
}

function conversationPath(id: string): string {
	return `${sessionDir(id)}/conversation.asonl`
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

function makeBlockRef(): string {
	return `${Date.now()}-${randomBytes(3).toString('hex')}`
}

async function writeBlock(sessionId: string, ref: string, data: any): Promise<void> {
	await ensureBlocksDir(sessionId)
	await writeFile(`${blocksDir(sessionId)}/${ref}.ason`, stringify(data) + '\n')
}

async function readBlock(sessionId: string, ref: string): Promise<any | null> {
	const path = `${blocksDir(sessionId)}/${ref}.ason`
	if (!existsSync(path)) return null
	try {
		return parse(await readFile(path, 'utf-8'))
	} catch {
		return null
	}
}

// Lean message serialization

function countWords(text: string): number {
	return text.split(/\s+/).filter(Boolean).length
}

/** Convert a batch of new runtime messages to lean format, writing block files. */
async function toLeanMessages(sessionId: string, messages: any[]): Promise<any[]> {
	const toolRefMap = new Map<string, string>()
	const leanMessages: any[] = []
	const ts = new Date().toISOString()

	for (const msg of messages) {
		if (msg.role === 'assistant' && Array.isArray(msg.content)) {
			const lean: any = { role: 'assistant', ts }

			// Extract thinking block (API sends at most one per response)
			const thinkingBlock = msg.content.find((b: any) => b.type === 'thinking')
			if (thinkingBlock?.thinking) {
				const ref = makeBlockRef()
				await writeBlock(sessionId, ref, {
					thinking: thinkingBlock.thinking,
					signature: thinkingBlock.signature,
				})
				lean.thinking = { ref, words: countWords(thinkingBlock.thinking) }
			}

			// Process remaining content
			const otherBlocks = msg.content.filter((b: any) => b.type !== 'thinking')
			const leanContent: any[] = []
			for (const block of otherBlocks) {
				if (block.type === 'tool_use') {
					const ref = makeBlockRef()
					toolRefMap.set(block.id, ref)
					await writeBlock(sessionId, ref, { call: { name: block.name, input: block.input } })
					leanContent.push({ type: 'tool_use', id: block.id, name: block.name, ref })
				} else {
					leanContent.push(block)
				}
			}

			// Simplify text-only responses to a string
			if (leanContent.length === 1 && leanContent[0].type === 'text' && !lean.thinking) {
				lean.content = leanContent[0].text
			} else {
				lean.content = leanContent.length > 0 ? leanContent : ''
			}

			leanMessages.push(lean)
		} else if (msg.role === 'user' && Array.isArray(msg.content)) {
			const leanContent: any[] = []
			for (const block of msg.content) {
				if (block.type === 'tool_result') {
					const resultContent = typeof block.content === 'string'
						? block.content
						: JSON.stringify(block.content ?? '')
					const ref = toolRefMap.get(block.tool_use_id)
					if (ref) {
						// Update the block file to include the result
						const existing = await readBlock(sessionId, ref)
						if (existing) {
							existing.result = { content: resultContent }
							await writeBlock(sessionId, ref, existing)
						}
						leanContent.push({ type: 'tool_result', tool_use_id: block.tool_use_id, ref })
					} else {
						// Orphaned tool result — write standalone block
						const newRef = makeBlockRef()
						await writeBlock(sessionId, newRef, { result: { content: resultContent } })
						leanContent.push({ type: 'tool_result', tool_use_id: block.tool_use_id, ref: newRef })
					}
				} else {
					leanContent.push(block)
				}
			}
			leanMessages.push({ role: 'user', content: leanContent, ts })
		} else {
			leanMessages.push({ ...msg, ts })
		}
	}

	return leanMessages
}

/** Resolve a lean message from disk back to full API format. */
async function fromLeanMessage(lean: any, sessionId: string): Promise<any> {
	if (lean.role === 'assistant') {
		const content: any[] = []

		// Restore thinking block
		if (lean.thinking?.ref) {
			const block = await readBlock(sessionId, lean.thinking.ref)
			if (block) {
				content.push({
					type: 'thinking',
					thinking: block.thinking,
					signature: block.signature,
				})
			}
		}

		// Restore content blocks
		if (typeof lean.content === 'string') {
			if (lean.content) content.push({ type: 'text', text: lean.content })
		} else if (Array.isArray(lean.content)) {
			for (const block of lean.content) {
				if (block.type === 'tool_use' && block.ref) {
					const data = await readBlock(sessionId, block.ref)
					content.push({
						type: 'tool_use',
						id: block.id,
						name: block.name,
						input: data?.call?.input ?? {},
					})
				} else {
					content.push(block)
				}
			}
		}

		return { role: 'assistant', content }
	}

	if (lean.role === 'user' && Array.isArray(lean.content)) {
		const content: any[] = []
		for (const block of lean.content) {
			if (block.type === 'tool_result' && block.ref) {
				const data = await readBlock(sessionId, block.ref)
				content.push({
					type: 'tool_result',
					tool_use_id: block.tool_use_id,
					content: data?.result?.content ?? '',
				})
			} else {
				content.push(block)
			}
		}
		return { role: 'user', content }
	}

	// Simple text message — strip ts
	const { ts, ...rest } = lean
	return rest
}

// Session info (persisted per-session metadata)

export interface SessionMeta {
	workingDir: string
	model?: string
	topic?: string
	updatedAt: string
	lastPrompt?: string
	tokenTotals?: TokenTotals
}

export async function saveSessionInfo(id: string, meta: SessionMeta): Promise<void> {
	await ensureSessionDir(id)
	await writeFile(infoPath(id), stringify(meta) + '\n')
}

export async function loadSessionInfo(id: string): Promise<SessionMeta | null> {
	for (const path of [infoPath(id), `${sessionDir(id)}/meta.ason`]) {
		if (!existsSync(path)) continue
		try {
			return parse(await readFile(path, 'utf-8')) as unknown as SessionMeta
		} catch {
			continue
		}
	}
	return null
}

// Conversation event log

export type ConversationEvent =
	| { type: 'user'; text: string; ts: string }
	| { type: 'assistant'; text: string; thinking?: string; ts: string }
	| { type: 'model'; from: string; to: string; ts: string }
	| { type: 'fork'; parent: string; child: string; ts: string }
	| { type: 'topic'; from?: string; to: string; auto?: boolean; ts: string }
	| { type: 'handoff'; ts: string }
	| { type: 'reset'; ts: string }
	| { type: 'cd'; from: string; to: string; ts: string }
	| { type: 'start'; workingDir: string; ts: string }

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

export type ReplayConversationEvent = Extract<ConversationEvent, { type: 'user' | 'assistant' }>

export function replayConversationEvents(events: ConversationEvent[]): ReplayConversationEvent[] {
	let startIdx = 0
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type === 'reset' || events[i].type === 'handoff') {
			startIdx = i + 1
			break
		}
	}
	const replay: ReplayConversationEvent[] = []
	for (const event of events.slice(startIdx)) {
		if (event.type !== 'user' && event.type !== 'assistant') continue
		const last = replay[replay.length - 1]
		if (event.type === 'assistant' && last?.type === 'assistant') {
			last.text += '\n\n' + event.text
			// Keep first thinking; later tool-loop turns rarely have one
			if (!last.thinking && event.thinking) last.thinking = event.thinking
		} else {
			replay.push({ ...event })
		}
	}
	return replay
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

export async function saveDraft(sessionId: string, text: string): Promise<void> {
	if (!text) {
		const path = draftPath(sessionId)
		if (existsSync(path)) {
			const { unlink } = await import('fs/promises')
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
		const registry: SessionRegistry = { activeSessionId: session.id, sessions: [session] }
		await saveSessionRegistry(registry)
		return registry
	}

	if (!existsSync(SESSIONS_INDEX)) return defaultRegistry()

	try {
		const raw = await readFile(SESSIONS_INDEX, 'utf-8')
		const parsed = parse(raw) as Partial<SessionRegistry>
		const sessions = Array.isArray(parsed.sessions)
			? parsed.sessions.filter((s: any) => s?.id).map((s: any) => ({ ...s, busy: false }))
			: []
		if (sessions.length === 0) return defaultRegistry()
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

export async function saveSessionRegistry(registry: SessionRegistry): Promise<void> {
	ensureStateDir()
	await writeFile(SESSIONS_INDEX, stringify(registry) + '\n')
}

// Session load/save (v2 — append-only with block refs)

export async function loadSession(
	sessionId: string,
): Promise<{ messages: any[]; tokenTotals: TokenTotals; persistedCount: number } | null> {
	const path = sessionPath(sessionId)
	if (!existsSync(path)) return null
	try {
		const raw = await readFile(path, 'utf-8')
		if (!raw.trim()) return null
		const leanMessages = parseAll(raw) as any[]
		if (leanMessages.length === 0) return null

		const messages: any[] = []
		for (const lean of leanMessages) {
			messages.push(await fromLeanMessage(lean, sessionId))
		}

		const repaired = repairMessages(messages)
		const meta = await loadSessionInfo(sessionId)
		return {
			messages: repaired,
			tokenTotals: meta?.tokenTotals ?? { ...EMPTY_TOTALS },
			persistedCount: repaired.length,
		}
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

/**
 * Append new messages to session.asonl with block refs.
 * Returns the new persisted count (= messages.length).
 */
export async function saveSession(
	sessionId: string,
	messages: any[],
	persistedCount: number,
	tokenTotals: TokenTotals,
	meta?: Omit<SessionMeta, 'updatedAt' | 'lastPrompt' | 'tokenTotals'>,
): Promise<number> {
	await ensureSessionDir(sessionId)

	if (persistedCount < messages.length) {
		const newMessages = messages.slice(persistedCount)
		const leanMessages = await toLeanMessages(sessionId, newMessages)
		const lines = leanMessages.map(m => stringify(m, 'short')).join('\n') + '\n'
		await appendFile(sessionPath(sessionId), lines)
	}

	if (meta) {
		await saveSessionInfo(sessionId, {
			...meta,
			updatedAt: new Date().toISOString(),
			lastPrompt: extractLastPrompt(messages),
			tokenTotals,
		})
	}

	return messages.length
}

// Rotation (replaces handoff and clear)

/** Rotate session.asonl → session.N.asonl. Returns the rotation number. */
export async function rotateSession(sessionId: string): Promise<number> {
	const dir = sessionDir(sessionId)
	const sessPath = sessionPath(sessionId)
	if (!existsSync(sessPath)) return 0

	// Find highest existing rotation number
	let maxN = 0
	if (existsSync(dir)) {
		for (const f of readdirSync(dir)) {
			const match = f.match(/^session\.(\d+)\.asonl$/)
			if (match) maxN = Math.max(maxN, parseInt(match[1], 10))
		}
	}

	const newN = maxN + 1
	await rename(sessPath, `${dir}/session.${newN}.asonl`)
	return newN
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

	if (userPrompts.length === 0) return `Session context was purged to avoid exceeding the token limit. No user prompts in previous session. Complete session history is at ${dir}/session.*.asonl + blocks/`

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
	lines.push(`If these are enough to remember what you were doing, feel free to continue after verifying with the user. If needed, the complete session history is at ${dir}/session.*.asonl + blocks/`)

	return lines.join('\n')
}

// Fork: copy session state to a new session

export async function forkSession(sourceId: string): Promise<string> {
	const newId = await makeSessionId()
	const srcDir = sessionDir(sourceId)
	const dstDir = sessionDir(newId)
	await mkdir(dstDir, { recursive: true })

	for (const file of ['session.asonl', 'conversation.asonl']) {
		const src = `${srcDir}/${file}`
		if (existsSync(src)) await copyFile(src, `${dstDir}/${file}`)
	}

	// Copy blocks directory
	const srcBlocks = `${srcDir}/blocks`
	if (existsSync(srcBlocks)) {
		const dstBlocks = `${dstDir}/blocks`
		await mkdir(dstBlocks, { recursive: true })
		const files = await readdir(srcBlocks)
		for (const f of files) {
			await copyFile(`${srcBlocks}/${f}`, `${dstBlocks}/${f}`)
		}
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
