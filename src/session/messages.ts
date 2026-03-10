// Conversation log — append-only ASONL per session.
// Tool call data lives in blocks/ as separate .ason files for compactness
// and fork sharing. The log only stores refs (pointers) to blocks.

import { writeFile, readFile, unlink } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { Log } from '../utils/log.ts'
import { sessionDir, blocksDir, ensureDir } from '../state.ts'
import { stringify, parse } from '../utils/ason.ts'
import { logNameCache } from './session.ts'
import { compactApiMessages } from './compact.ts'

function resolveLogName(sessionId: string): string {
	const cached = logNameCache.get(sessionId)
	if (cached) return cached
	// Read from meta.ason
	const metaPath = `${sessionDir(sessionId)}/meta.ason`
	if (existsSync(metaPath)) {
		try {
			const meta = parse(readFileSync(metaPath, 'utf-8')) as any
			const name = meta?.log ?? 'messages.asonl'
			logNameCache.set(sessionId, name)
			return name
		} catch {}
	}
	return 'messages.asonl'
}

function messagesLog(sessionId: string) {
	return new Log<Message>(`${sessionDir(sessionId)}/${resolveLogName(sessionId)}`)
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
	thinkingSignature?: string
	thinkingRef?: string
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
	| { type: 'info'; text: string; level?: string; detail?: string; ts: string }
	| { type: 'reset'; ts: string }
	| { type: 'compact'; ts: string }
	| { type: 'forked_from'; parent: string; ts: string }

// ── Block I/O ──

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

const sessionStartCache = new Map<string, number>()

function sessionStart(sessionId: string): number {
	let ts = sessionStartCache.get(sessionId)
	if (ts !== undefined) return ts
	try {
		const meta = parse(readFileSync(`${sessionDir(sessionId)}/meta.ason`, 'utf-8')) as any
		ts = new Date(meta.createdAt).getTime()
	} catch {
		ts = Date.now()
	}
	sessionStartCache.set(sessionId, ts)
	return ts
}

export function makeBlockRef(sessionId: string): string {
	const offset = Math.max(0, Date.now() - sessionStart(sessionId)).toString(36).padStart(6, '0')
	const bytes = randomBytes(3)
	let suffix = ''
	for (let i = 0; i < 3; i++) suffix += ID_CHARS[bytes[i] % ID_CHARS.length]
	return `${offset}-${suffix}`
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

/** Write assistant entry with block files for tools/thinking. Returns the log entry + tool ref map. */
export async function writeAssistantEntry(
	sessionId: string,
	opts: { text?: string; thinkingText?: string; thinkingRef?: string; thinkingSignature?: string; toolCalls?: { id: string; name: string; input: unknown }[]; usage?: { input: number; output: number } },
): Promise<{ entry: AssistantMessage; toolRefMap: Map<string, string> }> {
	const entry: AssistantMessage = { role: 'assistant', ts: new Date().toISOString() }
	const toolRefMap = new Map<string, string>()

	if (opts.text) entry.text = opts.text
	if (opts.thinkingText) {
		entry.thinkingText = opts.thinkingText
		const ref = opts.thinkingRef || makeBlockRef(sessionId)
		entry.thinkingRef = ref
		await writeBlock(sessionId, ref, { thinking: opts.thinkingText, signature: opts.thinkingSignature })
	}
	if (opts.thinkingSignature) entry.thinkingSignature = opts.thinkingSignature
	if (opts.usage) (entry as any).usage = opts.usage

	if (opts.toolCalls && opts.toolCalls.length > 0) {
		entry.tools = []
		for (const t of opts.toolCalls) {
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
	output: string | any[],
	toolRefMap: Map<string, string>,
	status: 'done' | 'error' = 'done',
): Promise<ToolResultMessage> {
	const ref = toolRefMap.get(toolUseId)!
	const existing = await readBlock(sessionId, ref)
	if (existing) {
		existing.result = { content: output, status }
		await writeBlock(sessionId, ref, existing)
	}
	return { role: 'tool_result', tool_use_id: toolUseId, ref, ts: new Date().toISOString() }
}

/** Update a block's call.input after hook transforms; stash original if different. */
export async function updateBlockInput(sessionId: string, ref: string, input: unknown, originalInput: unknown): Promise<void> {
	const block = await readBlock(sessionId, ref)
	if (!block?.call) return
	block.call.originalInput = originalInput
	block.call.input = input
	await writeBlock(sessionId, ref, block)
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
				const ref = makeBlockRef(sessionId)
				await writeBlock(sessionId, ref, { media_type: mediaType, data: data.toString('base64') })
				apiBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } })
				logBlocks.push({ type: 'image', ref })
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
							blocks.push({ type: 'image', source: { type: 'base64', media_type: data.media_type, data: data.data }, _ref: b.ref })
						}
					} else {
						blocks.push(b)
					}
				}
				out.push({ role: 'user', content: blocks })
			}
		} else if (msg.role === 'assistant') {
			const content: any[] = []
			// Only include thinking if we have a valid signature
			if (msg.thinkingText && msg.thinkingSignature) {
				content.push({ type: 'thinking', thinking: msg.thinkingText, signature: msg.thinkingSignature })
			}
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
			if (typeof content === 'string' && content.length > MAX_API_OUTPUT)
				content = content.slice(0, MAX_API_OUTPUT) + `\n[truncated ${content.length - MAX_API_OUTPUT} chars]`
			out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.tool_use_id, content, _ref: msg.ref }] })
		}
	}
	// Ensure every tool_use has a matching tool_result — synthesize missing ones
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
	const compacted = compactApiMessages(out)
	// Strip internal _ref before sending to API (providers reject extra fields)
	for (const msg of compacted) {
		if (msg.role === 'user' && Array.isArray(msg.content)) {
			for (const b of msg.content) {
				if (b._ref) delete b._ref
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

	const dir = sessionDir(sessionId)

	if (userPrompts.length === 0) return `Context was compacted. No user prompts in previous conversation. Full history: ${dir}/messages*.asonl + blocks/`

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
	lines.push(`Full history: ${dir}/messages*.asonl + blocks/`)

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
