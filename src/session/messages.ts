// Conversation log — append-only ASONL per session.
// Tool call data lives in blobs/ as separate .ason files for compactness
// and fork sharing. The log only stores blob ids (pointers) to blobs.

import { writeFile, readFile, unlink } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { Log } from '../utils/log.ts'
import { state } from '../state.ts'
import { ason } from '../utils/ason.ts'
import { session } from './session.ts'
import { compact, type CompactOpts } from './compact.ts'

function resolveLogName(sessionId: string): string {
	const cached = session.logNameCache.get(sessionId)
	if (cached) return cached
	// Read from meta.ason
	const metaPath = `${state.sessionDir(sessionId)}/meta.ason`
	if (existsSync(metaPath)) {
		try {
			const meta = ason.parse(readFileSync(metaPath, 'utf-8')) as any
			const name = meta?.log ?? 'messages.asonl'
			session.logNameCache.set(sessionId, name)
			return name
		} catch {}
	}
	return 'messages.asonl'
}

function messagesLog(sessionId: string) {
	return new Log<Message>(`${state.sessionDir(sessionId)}/${resolveLogName(sessionId)}`)
}

// ── Message types ──

export interface UserMessage {
	role: 'user'
	content: string | { type: 'text'; text: string }[] | { type: 'image'; blobId: string }[]
	ts: string
}

export interface AssistantMessage {
	role: 'assistant'
	text?: string
	thinkingText?: string
	thinkingSignature?: string
	thinkingBlobId?: string
	tools?: { id: string; name: string; blobId: string }[]
	usage?: { input: number; output: number }
	ts: string
}

export interface ToolResultMessage {
	role: 'tool_result'
	tool_use_id: string
	blobId: string
	ts: string
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage
	| { type: 'info'; text: string; level?: string; detail?: string; ts: string }
	| { type: 'reset'; ts: string }
	| { type: 'compact'; ts: string }
	| { type: 'forked_from'; parent: string; ts: string }

// ── Blob I/O ──

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

const sessionStartCache = new Map<string, number>()

function sessionStart(sessionId: string): number {
	let ts = sessionStartCache.get(sessionId)
	if (ts !== undefined) return ts
	try {
		const meta = ason.parse(readFileSync(`${state.sessionDir(sessionId)}/meta.ason`, 'utf-8')) as any
		ts = new Date(meta.createdAt).getTime()
	} catch {
		ts = Date.now()
	}
	sessionStartCache.set(sessionId, ts)
	return ts
}

export function makeBlobId(sessionId: string): string {
	const offset = Math.max(0, Date.now() - sessionStart(sessionId)).toString(36).padStart(6, '0')
	const bytes = randomBytes(3)
	let suffix = ''
	for (let i = 0; i < 3; i++) suffix += ID_CHARS[bytes[i] % ID_CHARS.length]
	return `${offset}-${suffix}`
}

export async function writeBlob(sessionId: string, blobId: string, data: unknown): Promise<void> {
	const dir = state.blobsDir(sessionId)
	state.ensureDir(dir)
	await writeFile(`${dir}/${blobId}.ason`, ason.stringify(data) + '\n')
}

export async function readBlob(sessionId: string, blobId: string): Promise<any | null> {
	const path = `${state.blobsDir(sessionId)}/${blobId}.ason`
	if (existsSync(path)) {
		try { return ason.parse(await readFile(path, 'utf-8')) }
		catch { return null }
	}
	const parent = getParentSessionId(sessionId)
	if (parent) return readBlob(parent, blobId)
	return null
}

const parentCache = new Map<string, string | null>()

function getParentSessionId(sessionId: string): string | null {
	const cached = parentCache.get(sessionId)
	if (cached !== undefined) return cached
	const path = `${state.sessionDir(sessionId)}/messages.asonl`
	if (!existsSync(path)) { parentCache.set(sessionId, null); return null }
	try {
		const raw = readFileSync(path, 'utf-8')
		const firstLine = raw.split('\n', 1)[0]
		if (!firstLine?.trim()) { parentCache.set(sessionId, null); return null }
		const entry = ason.parse(firstLine) as any
		if (entry?.type === 'forked_from' && entry.parent) {
			parentCache.set(sessionId, entry.parent)
			return entry.parent
		}
	} catch {}
	parentCache.set(sessionId, null)
	return null
}

/** Get the last known API usage from persisted messages. */
export function getLastUsage(sessionId: string): { input: number; output: number } | null {
	const msgs = readMessages(sessionId)
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i]
		if (m.role === 'assistant' && m.usage) return m.usage
	}
	return null
}

// ── Assistant/tool entry writers ──

/** Write assistant entry with blob files for tools/thinking. Returns the log entry + tool blob map. */
export async function writeAssistantEntry(
	sessionId: string,
	opts: { text?: string; thinkingText?: string; thinkingBlobId?: string; thinkingSignature?: string; toolCalls?: { id: string; name: string; input: unknown }[]; usage?: { input: number; output: number } },
): Promise<{ entry: AssistantMessage; toolBlobMap: Map<string, string> }> {
	const entry: AssistantMessage = { role: 'assistant', ts: new Date().toISOString() }
	const toolBlobMap = new Map<string, string>()

	if (opts.text) entry.text = opts.text
	if (opts.thinkingText) {
		entry.thinkingText = opts.thinkingText
		const blobId = opts.thinkingBlobId || makeBlobId(sessionId)
		entry.thinkingBlobId = blobId
		await writeBlob(sessionId, blobId, { thinking: opts.thinkingText, signature: opts.thinkingSignature })
	}
	if (opts.thinkingSignature) entry.thinkingSignature = opts.thinkingSignature
	if (opts.usage) entry.usage = opts.usage

	if (opts.toolCalls && opts.toolCalls.length > 0) {
		entry.tools = []
		for (const t of opts.toolCalls) {
			const blobId = makeBlobId(sessionId)
			toolBlobMap.set(t.id, blobId)
			await writeBlob(sessionId, blobId, { call: { name: t.name, input: t.input } })
			entry.tools.push({ id: t.id, name: t.name, blobId })
		}
	}

	return { entry, toolBlobMap }
}

/** Write tool result to blob file and return log entry. */
export async function writeToolResultEntry(
	sessionId: string,
	toolUseId: string,
	output: string | any[],
	toolBlobMap: Map<string, string>,
	status: 'done' | 'error' = 'done',
): Promise<ToolResultMessage> {
	const blobId = toolBlobMap.get(toolUseId)!
	const existing = await readBlob(sessionId, blobId)
	if (existing) {
		existing.result = { content: output, status }
		await writeBlob(sessionId, blobId, existing)
	}
	return { role: 'tool_result', tool_use_id: toolUseId, blobId, ts: new Date().toISOString() }
}

/** Update a blob's call.input after hook transforms; stash original if different. */
export async function updateBlobInput(sessionId: string, blobId: string, input: unknown, originalInput: unknown): Promise<void> {
	const blob = await readBlob(sessionId, blobId)
	if (!blob?.call) return
	blob.call.originalInput = originalInput
	blob.call.input = input
	await writeBlob(sessionId, blobId, blob)
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp']

const MEDIA_TYPES: Record<string, string> = {
	jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
	webp: 'image/webp', png: 'image/png',
}

/** Parse inline `[path.png]` refs → UserMessage with image blobs stored in blobs/. */
export async function parseUserContent(
	sessionId: string,
	input: string,
): Promise<{ apiContent: any; logContent: UserMessage['content'] }> {
	const pattern = /\[([^\]]+\.(png|jpg|jpeg|gif|webp|txt))\]/gi
	const allMatches = [...input.matchAll(pattern)]
	// Only expand .txt from /tmp/hal/ (paste files) to avoid leaking arbitrary files
	const matches = allMatches.filter(m => {
		const ext = m[2].toLowerCase()
		return ext !== 'txt' || m[1].startsWith('/tmp/hal/')
	})
	if (matches.length === 0) return { apiContent: input, logContent: input }

	const apiBlocks: any[] = []
	const logBlocks: any[] = []
	let lastIndex = 0

	for (const match of matches) {
		const filePath = match[1].startsWith('~') ? match[1].replace('~', homedir()) : match[1]
		const ext = match[2].toLowerCase()
		const before = input.slice(lastIndex, match.index)
		if (before.trim()) {
			apiBlocks.push({ type: 'text', text: before })
			logBlocks.push({ type: 'text', text: before })
		}

		if (!existsSync(filePath)) {
			apiBlocks.push({ type: 'text', text: `[file not found: ${filePath}]` })
			logBlocks.push({ type: 'text', text: `[file not found: ${filePath}]` })
		} else if (ext === 'txt') {
			try {
				const text = readFileSync(filePath, 'utf8')
				apiBlocks.push({ type: 'text', text })
				logBlocks.push({ type: 'text', text: `[${filePath}]` })
			} catch {
				apiBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
				logBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
			}
		} else if (IMAGE_EXTS.includes(ext)) {
			try {
				const data = readFileSync(filePath)
				const mediaType = MEDIA_TYPES[ext] ?? 'image/png'
				const blobId = makeBlobId(sessionId)
				await writeBlob(sessionId, blobId, { media_type: mediaType, data: data.toString('base64') })
				apiBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } })
				logBlocks.push({ type: 'image', blobId })
			} catch {
				apiBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
				logBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
			}
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
	state.ensureDir(state.sessionDir(sessionId))
	await messagesLog(sessionId).append(...entries)
}

export async function readMessages(sessionId: string): Promise<Message[]> {
	return messagesLog(sessionId).readAll()
}

const MAX_API_OUTPUT = 50_000

const MODEL_CHANGE_THRESHOLD = 10

/** If a model change happened recently, boost heavy content threshold so the new model sees more history. */
function detectCompactOpts(msgs: Message[]): CompactOpts | undefined {
	let lastModelChangeIdx = -1
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i] as any
		if (m.type === 'info' && typeof m.text === 'string' && m.text.startsWith('[model]')) {
			lastModelChangeIdx = i
			break
		}
	}
	if (lastModelChangeIdx < 0) return undefined
	// Count completed turns (assistant final responses) after the model change
	let turnsAfter = 0
	for (let i = lastModelChangeIdx + 1; i < msgs.length; i++) {
		const m = msgs[i] as any
		if (m.role === 'assistant' && !m.tools) turnsAfter++
	}
	if (turnsAfter <= MODEL_CHANGE_THRESHOLD) return { heavyThreshold: MODEL_CHANGE_THRESHOLD }
	return undefined
}

/** Load messages for API replay: converts stored format → Anthropic API format. */
export async function loadApiMessages(sessionId: string): Promise<any[]> {
	const all = await loadAllMessages(sessionId)
	const start = findReplayStart(all)
	const sliced = all.slice(start)
	const compactOpts = detectCompactOpts(sliced)
	const out: any[] = []
	for (const m of sliced) {
		const msg = m as any
		if (!msg.role) continue
		if (msg.role === 'user') {
			if (typeof msg.content === 'string') {
				out.push({ role: 'user', content: msg.content })
			} else if (Array.isArray(msg.content)) {
				const blocks: any[] = []
				for (const b of msg.content) {
					if (b.type === 'image' && b.blobId) {
						const data = await readBlob(sessionId, b.blobId)
						if (data?.media_type && data?.data) {
							blocks.push({ type: 'image', source: { type: 'base64', media_type: data.media_type, data: data.data }, _blobId: b.blobId })
						}
					} else {
						blocks.push(b)
					}
				}
				out.push({ role: 'user', content: blocks })
			}
		} else if (msg.role === 'assistant') {
			const content: any[] = []
			if (msg.thinkingText && msg.thinkingSignature)
				content.push({ type: 'thinking', thinking: msg.thinkingText, signature: msg.thinkingSignature })
			if (msg.text) content.push({ type: 'text', text: msg.text })
			if (msg.tools) {
				for (const t of msg.tools) {
					const blob = await readBlob(sessionId, t.blobId)
					content.push({ type: 'tool_use', id: t.id, name: t.name, input: blob?.call?.input ?? {} })
				}
			}
			if (content.length) out.push({ role: 'assistant', content })
		} else if (msg.role === 'tool_result') {
			const blob = await readBlob(sessionId, msg.blobId)
			let content = blob?.result?.content ?? '[interrupted]'
			if (typeof content === 'string' && content.length > MAX_API_OUTPUT)
				content = content.slice(0, MAX_API_OUTPUT) + `\n[truncated ${content.length - MAX_API_OUTPUT} chars]`
			out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.tool_use_id, content, _blobId: msg.blobId }] })
		}
	}
	const resultIds = new Set<string>()
	for (const m of out) {
		if (m.role !== 'user' || !Array.isArray(m.content)) continue
		for (const b of m.content) {
			if (b.type === 'tool_result') resultIds.add(b.tool_use_id)
		}
	}
	for (let i = 0; i < out.length; i++) {
		if (out[i].role !== 'assistant' || !Array.isArray(out[i].content)) continue
		const missing = out[i].content.filter((b: any) => b.type === 'tool_use' && !resultIds.has(b.id))
		if (missing.length > 0) {
			const synthetic = {
				role: 'user',
				content: missing.map((b: any) => ({ type: 'tool_result', tool_use_id: b.id, content: '[interrupted]' })),
			}
			out.splice(i + 1, 0, synthetic)
			i++
		}
	}
	const compacted = compact.compactApiMessages(out, compactOpts)
	for (const msg of compacted) {
		if (msg.role === 'user' && Array.isArray(msg.content)) {
			for (const b of msg.content) {
				if (b._blobId) delete b._blobId
			}
		}
	}
	return compacted
}

/** Follow fork chain to load full history. */
export async function loadAllMessages(sessionId: string): Promise<Message[]> {
	const entries = await readMessages(sessionId)
	if (entries.length > 0 && (entries[0] as any).type === 'forked_from') {
		const parent = (entries[0] as any).parent
		const forkTs = (entries[0] as any).ts
		const parentEntries = await loadAllMessages(parent)
		const before = parentEntries.filter((e: any) => !e.ts || e.ts < forkTs)
		return [...before, ...entries.slice(1)]
	}
	return entries
}

function findReplayStart(entries: Message[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as any
		if (e.type === 'reset' || e.type === 'compact') return i + 1
	}
	return 0
}

/** Detect interrupted tools: assistant entry has tool blob ids without matching tool_result entries. */
export function detectInterruptedTools(messages: Message[]): { name: string; id: string; blobId: string }[] {
	const completedToolIds = new Set<string>()
	for (const m of messages) {
		if ((m as any).role === 'tool_result') completedToolIds.add((m as any).tool_use_id)
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as any
		if (m.role === 'assistant' && m.tools) {
			const interrupted: { name: string; id: string; blobId: string }[] = []
			for (const t of m.tools) {
				if (!completedToolIds.has(t.id)) interrupted.push(t)
			}
			return interrupted
		}
	}
	return []
}

/** Build a context summary from user prompts for context compaction. */
export function buildCompactionContext(sessionId: string, messages: Message[]): string {
	const userPrompts: string[] = []
	for (const msg of messages) {
		if ((msg as any).role !== 'user') continue
		const m = msg as any
		const text = typeof m.content === 'string' ? m.content : ''
		if (!text || text.startsWith('[')) continue
		userPrompts.push(text.split('\n')[0].slice(0, 200))
	}

	const dir = state.sessionDir(sessionId)

	if (userPrompts.length === 0) return `Context was compacted. No user prompts in previous conversation. Full history: ${dir}/messages*.asonl + blobs/`

	const lines: string[] = [
		'Context was compacted to avoid exceeding the token limit. Verify before assuming.',
		'',
		'User messages from previous conversation:',
		'',
	]

	if (userPrompts.length <= 20) {
		userPrompts.forEach((p, i) => lines.push(`${i + 1}. ${p}`))
	} else {
		lines.push('First 10:')
		userPrompts.slice(0, 10).forEach((p, i) => lines.push(`${i + 1}. ${p}`))
		lines.push('')
		lines.push('Last 10:')
		const start = userPrompts.length - 10
		userPrompts.slice(-10).forEach((p, i) => lines.push(`${start + i + 1}. ${p}`))
	}

	lines.push('')
	lines.push(`Full history: ${dir}/messages*.asonl + blobs/`)

	return lines.join('\n')
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
	return `${state.sessionDir(sessionId)}/draft.txt`
}

export async function saveDraft(sessionId: string, text: string): Promise<void> {
	if (!text) {
		const p = draftPath(sessionId)
		if (existsSync(p)) await unlink(p).catch(() => {})
		return
	}
	state.ensureDir(state.sessionDir(sessionId))
	await writeFile(draftPath(sessionId), text)
}

export async function loadDraft(sessionId: string): Promise<string> {
	const p = draftPath(sessionId)
	if (!existsSync(p)) return ''
	try { return await readFile(p, 'utf-8') } catch { return '' }
}

export const messages = {
	makeBlobId,
	writeBlob,
	readBlob,
	getLastUsage,
	writeAssistantEntry,
	writeToolResultEntry,
	updateBlobInput,
	parseUserContent,
	appendMessages,
	readMessages,
	loadApiMessages,
	loadAllMessages,
	detectInterruptedTools,
	buildCompactionContext,
	loadInputHistory,
	saveDraft,
	loadDraft,
}
