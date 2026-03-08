// Conversation log — append-only ASONL per session.
// Tool call data lives in blocks/ as separate .ason files for compactness
// and fork sharing. The log only stores refs (pointers) to blocks.

import { writeFile, readFile, unlink } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { Log } from '../utils/log.ts'
import { sessionDir, blocksDir, ensureDir } from '../state.ts'
import { stringify, parse } from '../utils/ason.ts'

function messagesLog(sessionId: string) {
	return new Log<Message>(`${sessionDir(sessionId)}/messages.asonl`)
}

// ── Message types ──

export interface UserMessage {
	role: 'user'
	content: string | { type: 'text'; text: string }[] | { type: 'image'; ref: string }[]
	ts: string
}

export interface AssistantMessage {
	role: 'assistant'
	text?: string
	thinkingText?: string
	tools?: { id: string; name: string; ref: string }[]
	ts: string
}

export interface ToolResultMessage {
	role: 'tool_result'
	tool_use_id: string
	ref: string
	ts: string
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage
	| { type: 'info'; text: string; level?: string; ts: string }
	| { type: 'reset'; ts: string }
	| { type: 'forked_from'; parent: string; ts: string }

// ── Block I/O ──

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

function makeBlockRef(): string {
	const bytes = randomBytes(6)
	let s = ''
	for (let i = 0; i < 6; i++) s += ID_CHARS[bytes[i] % ID_CHARS.length]
	return s
}

export async function writeBlock(sessionId: string, ref: string, data: unknown): Promise<void> {
	const dir = blocksDir(sessionId)
	ensureDir(dir)
	await writeFile(`${dir}/${ref}.ason`, stringify(data) + '\n')
}

export async function readBlock(sessionId: string, ref: string): Promise<any | null> {
	const path = `${blocksDir(sessionId)}/${ref}.ason`
	if (existsSync(path)) {
		try { return parse(await readFile(path, 'utf-8')) }
		catch { return null }
	}
	// Walk fork chain — block may live in parent's blocks/
	const parent = getParentSessionId(sessionId)
	if (parent) return readBlock(parent, ref)
	return null
}

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

// ── Assistant/tool entry writers ──

/** Write assistant entry with block files for tools. Returns the log entry + tool ref map. */
export async function writeAssistantEntry(
	sessionId: string,
	opts: { text?: string; thinkingText?: string; toolCalls?: { id: string; name: string; input: unknown }[] },
): Promise<{ entry: AssistantMessage; toolRefMap: Map<string, string> }> {
	const entry: AssistantMessage = { role: 'assistant', ts: new Date().toISOString() }
	const toolRefMap = new Map<string, string>()

	if (opts.text) entry.text = opts.text
	if (opts.thinkingText) entry.thinkingText = opts.thinkingText

	if (opts.toolCalls && opts.toolCalls.length > 0) {
		entry.tools = []
		for (const t of opts.toolCalls) {
			const ref = makeBlockRef()
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
): Promise<ToolResultMessage> {
	const ref = toolRefMap.get(toolUseId)!
	const existing = await readBlock(sessionId, ref)
	if (existing) {
		existing.result = { content: output }
		await writeBlock(sessionId, ref, existing)
	}
	return { role: 'tool_result', tool_use_id: toolUseId, ref, ts: new Date().toISOString() }
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp']

const MEDIA_TYPES: Record<string, string> = {
	jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
	webp: 'image/webp', png: 'image/png',
}

/** Parse inline `[path.png]` refs → UserMessage with image blocks stored in blocks/. */
export async function parseUserContent(
	sessionId: string,
	input: string,
): Promise<{ apiContent: any; logContent: UserMessage['content'] }> {
	const pattern = /\[([^\]]+\.(png|jpg|jpeg|gif|webp))\]/gi
	const matches = [...input.matchAll(pattern)]
	if (matches.length === 0) return { apiContent: input, logContent: input }

	const apiBlocks: any[] = []
	const logBlocks: any[] = []
	let lastIndex = 0

	for (const match of matches) {
		const filePath = match[1]
		const ext = match[2].toLowerCase()
		const before = input.slice(lastIndex, match.index)
		if (before.trim()) {
			apiBlocks.push({ type: 'text', text: before })
			logBlocks.push({ type: 'text', text: before })
		}

		if (existsSync(filePath) && IMAGE_EXTS.includes(ext)) {
			try {
				const data = readFileSync(filePath)
				const mediaType = MEDIA_TYPES[ext] ?? 'image/png'
				const ref = makeBlockRef()
				await writeBlock(sessionId, ref, { media_type: mediaType, data: data.toString('base64') })
				apiBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } })
				logBlocks.push({ type: 'image', ref })
			} catch {
				apiBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
				logBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
			}
		} else {
			apiBlocks.push({ type: 'text', text: `[file not found: ${filePath}]` })
			logBlocks.push({ type: 'text', text: `[file not found: ${filePath}]` })
		}
		lastIndex = match.index! + match[0].length
	}

	const after = input.slice(lastIndex)
	if (after.trim()) {
		apiBlocks.push({ type: 'text', text: after })
		logBlocks.push({ type: 'text', text: after })
	}

	return { apiContent: apiBlocks, logContent: logBlocks as UserMessage['content'] }
}

// ── I/O ──

export async function appendMessages(sessionId: string, entries: Message[]): Promise<void> {
	if (entries.length === 0) return
	ensureDir(sessionDir(sessionId))
	await messagesLog(sessionId).append(...entries)
}

export async function readMessages(sessionId: string): Promise<Message[]> {
	return messagesLog(sessionId).readAll()
}

const MAX_API_OUTPUT = 50_000

/** Load messages for API replay: converts stored format → Anthropic API format. */
export async function loadApiMessages(sessionId: string): Promise<any[]> {
	const all = await loadAllMessages(sessionId)
	const start = findReplayStart(all)
	const out: any[] = []
	for (const m of all.slice(start)) {
		const msg = m as any
		if (!msg.role) continue
		if (msg.role === 'user') {
			if (typeof msg.content === 'string') {
				out.push({ role: 'user', content: msg.content })
			} else if (Array.isArray(msg.content)) {
				const blocks: any[] = []
				for (const b of msg.content) {
					if (b.type === 'image' && b.ref) {
						const data = await readBlock(sessionId, b.ref)
						if (data?.media_type && data?.data) {
							blocks.push({ type: 'image', source: { type: 'base64', media_type: data.media_type, data: data.data } })
						}
					} else {
						blocks.push(b)
					}
				}
				out.push({ role: 'user', content: blocks })
			}
		} else if (msg.role === 'assistant') {
			const content: any[] = []
			if (msg.text) content.push({ type: 'text', text: msg.text })
			if (msg.tools) {
				for (const t of msg.tools) {
					const block = await readBlock(sessionId, t.ref)
					content.push({ type: 'tool_use', id: t.id, name: t.name, input: block?.call?.input ?? {} })
				}
			}
			if (content.length) out.push({ role: 'assistant', content })
		} else if (msg.role === 'tool_result') {
			const block = await readBlock(sessionId, msg.ref)
			let content = block?.result?.content ?? '[interrupted]'
			if (content.length > MAX_API_OUTPUT) content = content.slice(0, MAX_API_OUTPUT) + `\n[truncated ${content.length - MAX_API_OUTPUT} chars]`
			out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.tool_use_id, content }] })
		}
	}
	return out
}

/** Follow fork chain to load full history. */
async function loadAllMessages(sessionId: string): Promise<Message[]> {
	const entries = await readMessages(sessionId)
	if (entries.length > 0 && (entries[0] as any).type === 'forked_from') {
		const parent = (entries[0] as any).parent
		const forkTs = (entries[0] as any).ts
		const parentEntries = await loadAllMessages(parent)
		const before = parentEntries.filter((e: any) => !e.ts || e.ts <= forkTs)
		return [...before, ...entries.slice(1)]
	}
	return entries
}

function findReplayStart(entries: Message[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as any
		if (e.type === 'reset' || e.type === 'handoff') return i + 1
	}
	return 0
}

/** Detect interrupted tools: assistant entry has tool refs without matching tool_result entries. */
export function detectInterruptedTools(messages: Message[]): { name: string; id: string; ref: string }[] {
	const completedToolIds = new Set<string>()
	for (const m of messages) {
		if ((m as any).role === 'tool_result') completedToolIds.add((m as any).tool_use_id)
	}
	// Check the last assistant message with tools
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as any
		if (m.role === 'assistant' && m.tools) {
			const interrupted: { name: string; id: string; ref: string }[] = []
			for (const t of m.tools) {
				if (!completedToolIds.has(t.id)) interrupted.push(t)
			}
			return interrupted
		}
	}
	return []
}

/** Extract user input texts for prompt history. */
export async function loadInputHistory(sessionId: string): Promise<string[]> {
	const entries = await readMessages(sessionId)
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

// ── Draft persistence ──

function draftPath(sessionId: string): string {
	return `${sessionDir(sessionId)}/draft.txt`
}

export async function saveDraft(sessionId: string, text: string): Promise<void> {
	if (!text) {
		const p = draftPath(sessionId)
		if (existsSync(p)) await unlink(p).catch(() => {})
		return
	}
	ensureDir(sessionDir(sessionId))
	await writeFile(draftPath(sessionId), text)
}

export async function loadDraft(sessionId: string): Promise<string> {
	const p = draftPath(sessionId)
	if (!existsSync(p)) return ''
	try { return await readFile(p, 'utf-8') } catch { return '' }
}
