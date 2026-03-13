// Converts stored history entries into API-ready message arrays.

import { prune } from './prune.ts'
import { blob } from './blob.ts'
import type { Message } from './history.ts'

export const historyConfig = {
	maxApiOutput: 50_000,
	errorTurnTtl: 3, // expire injected errors after this many user turns
}

export function applyModelEvent(currentModel: string | undefined, entry: any): string | undefined {
	if (entry?.type !== 'session') return currentModel
	if (entry.action === 'init' && typeof entry.model === 'string' && entry.model) return entry.model
	if (entry.action === 'model-set' && typeof entry.model === 'string' && entry.model) return entry.model
	if (entry.action === 'model-change' && typeof entry.new === 'string' && entry.new) return entry.new
	return currentModel
}

function initialModelFromEntries(entries: Message[]): string | undefined {
	for (const entry of entries) {
		const e = entry as any
		if (e.type !== 'session') continue
		if (e.action === 'init' && typeof e.model === 'string' && e.model) return e.model
		if (e.action === 'model-set' && typeof e.model === 'string' && e.model) return e.model
		if (e.action === 'model-change' && typeof e.old === 'string' && e.old) return e.old
	}
	return undefined
}

function findReplayStart(entries: Message[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as any
		if (e.type === 'reset' || e.type === 'compact') return i + 1
	}
	return 0
}

export async function loadApiMessages(sessionId: string, loadAllHistory: (id: string) => Promise<Message[]>): Promise<any[]> {
	const all = await loadAllHistory(sessionId)
	const start = findReplayStart(all)
	const sliced = all.slice(start)
	const pruneOpts = prune.detectPruneOpts(sliced)
	const out: any[] = []
	let currentModel = initialModelFromEntries(sliced)
	const totalUserTurns = sliced.filter(m => (m as any).role === 'user').length
	let userTurnsSeen = 0
	let pendingErrors: string[] = []
	for (const m of sliced) {
		const msg = m as any
		currentModel = applyModelEvent(currentModel, msg)
		// Collect error/warn/meta infos for injection into the next user message
		if (msg.type === 'info' && (msg.level === 'error' || msg.level === 'warn' || msg.level === 'meta')) {
			const turnsRemaining = totalUserTurns - userTurnsSeen
			if (turnsRemaining <= historyConfig.errorTurnTtl) {
				const prefix = msg.level === 'error' ? '[Error] ' : msg.level === 'warn' ? '[Warning] ' : ''
				pendingErrors.push(prefix + msg.text)
			}
			continue
		}
		if (!msg.role) continue
		if (msg.role === 'user') {
			userTurnsSeen++
			if (typeof msg.content === 'string') {
				if (pendingErrors.length > 0) {
					const infoText = pendingErrors.join('\n')
					pendingErrors = []
					out.push({ role: 'user', content: infoText + '\n' + msg.content })
				} else {
					out.push({ role: 'user', content: msg.content })
				}
			} else if (Array.isArray(msg.content)) {
				const blocks: any[] = []
				if (pendingErrors.length > 0) {
					blocks.push({ type: 'text', text: pendingErrors.join('\n') })
					pendingErrors = []
				}
				for (const b of msg.content) {
					if (b.type === 'image' && b.blobId) {
						const data = await blob.read(sessionId, b.blobId)
						const originalFile = typeof b.originalFile === 'string' ? b.originalFile : ''
						if (data?.media_type && data?.data) {
							const imageBlock: any = { type: 'image', source: { type: 'base64', media_type: data.media_type, data: data.data }, _blobId: b.blobId }
							if (originalFile) imageBlock._originalFile = originalFile
							blocks.push(imageBlock)
						} else {
							const fileHint = originalFile ? `; file ${originalFile}` : ''
							blocks.push({ type: 'text', text: `[image unavailable — blob ${b.blobId}${fileHint}; use read_blob if needed]` })
						}
					} else {
						blocks.push(b)
					}
				}
				out.push({ role: 'user', content: blocks })
			}
		} else if (msg.role === 'assistant') {
			pendingErrors = [] // discard errors not followed by a user message
			const content: any[] = []
			let thinkingText = msg.thinkingText
			let thinkingSignature = msg.thinkingSignature
			if (msg.thinkingBlobId && (!thinkingText || !thinkingSignature)) {
				const thinkingData = await blob.read(sessionId, msg.thinkingBlobId)
				if (!thinkingText) thinkingText = thinkingData?.thinking
				if (!thinkingSignature) thinkingSignature = thinkingData?.signature
			}
			if (thinkingText && thinkingSignature) {
				const thinkingBlock: any = { type: 'thinking', thinking: thinkingText, signature: thinkingSignature }
				if (currentModel) thinkingBlock._model = currentModel
				content.push(thinkingBlock)
			}
			if (msg.text) content.push({ type: 'text', text: msg.text })
			if (msg.tools) {
				for (const t of msg.tools) {
					const blobData = await blob.read(sessionId, t.blobId)
					content.push({ type: 'tool_use', id: t.id, name: t.name, input: blobData?.call?.input ?? {} })
				}
			}
			if (content.length) out.push({ role: 'assistant', content })
		} else if (msg.role === 'tool_result') {
			const blobData = await blob.read(sessionId, msg.blobId)
			let content = blobData?.result?.content ?? '[interrupted]'
			const maxApiOutput = historyConfig.maxApiOutput
			if (typeof content === 'string' && content.length > maxApiOutput)
				content = content.slice(0, maxApiOutput) + `\n[truncated ${content.length - maxApiOutput} chars]`
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
	const pruned = prune.pruneApiMessages(out, pruneOpts)
	for (const msg of pruned) {
		if (msg.role === 'user' && Array.isArray(msg.content)) {
			for (const b of msg.content) {
				if (b._blobId) delete b._blobId
				if (b._originalFile) delete b._originalFile
			}
		}
	}
	return pruned
}

export const apiMessages = {
	config: historyConfig,
	applyModelEvent,
	loadApiMessages,
}
