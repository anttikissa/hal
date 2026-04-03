// Convert stored history entries into API-ready message arrays.
//
// History entries use a compact on-disk format with blob references for large
// content. This module expands them into the format providers expect:
// - Anthropic: content block arrays with type: text/tool_use/tool_result/image/thinking
// - OpenAI: messages with role/content/tool_calls (not yet implemented, placeholder)
//
// Also handles context pruning: stripping old tool results, images, and thinking
// blocks to keep the context window manageable.

import type { HistoryEntry } from '../server/sessions.ts'
import { sessions } from '../server/sessions.ts'
import { blob } from './blob.ts'
import type { Message, ContentBlock } from '../protocol.ts'

// Format an ISO timestamp as local "HH:MM" for injecting into user messages.
// Lets the model reason about elapsed time without reading history files.
function formatLocalTime(ts?: string): string | null {
	if (!ts) return null
	try {
		const d = new Date(ts)
		if (isNaN(d.getTime())) return null
		return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
	} catch {
		return null
	}
}

const apiConfig = {
	// Max chars for tool result content before truncation
	maxToolOutput: 50_000,
	// Expire next-user injected infos after this many user turns
	injectTurnTtl: 3,
	// Pruning: strip heavy content after this many completed turns
	heavyThreshold: 4,
	// Pruning: strip thinking blocks after this many completed turns
	thinkingThreshold: 10,
}

// ── Model tracking ──

// Track which model is active by scanning session events in history.
function applyModelEvent(current: string | undefined, entry: any): string | undefined {
	if (entry?.type !== 'session') return current
	if (entry.action === 'model-set' && entry.model) return entry.model
	if (entry.action === 'model-change' && entry.new) return entry.new
	if (entry.action === 'init' && entry.model) return entry.model
	return current
}

// ── Replay start detection ──

// Find where to start replaying from. Resets and compactions mark a fresh start
// point — we only send messages after the last one.
function findReplayStart(entries: HistoryEntry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!
		if (e.type === 'reset' || e.type === 'compact') return i + 1
	}
	return 0
}

// ── Main conversion ──

// Convert session history to Anthropic API message format.
// Loads blobs for tool calls, handles images, manages injected info entries.
function toAnthropicMessages(sessionId: string, allEntries?: HistoryEntry[]): Message[] {
	const entries = allEntries ?? sessions.loadAllHistory(sessionId)
	const start = findReplayStart(entries)
	const sliced = entries.slice(start)
	const out: Message[] = []

	// If replay started after a compact entry with a summary, inject it
	// as a user+assistant pair so the model has context about prior conversation.
	if (start > 0) {
		const compactEntry = entries[start - 1]
		if (compactEntry?.type === 'compact' && compactEntry.summary) {
			out.push({
				role: 'user',
				content: `<context>\nHere is a summary of the conversation so far:\n${compactEntry.summary}\n</context>\n\nPlease continue from where we left off.`,
			})
			out.push({
				role: 'assistant',
				content: 'Understood. I have the context from our previous conversation and I\'m ready to continue.',
			})
		}
	}

	let currentModel: string | undefined
	const totalUserTurns = sliced.filter((m) => m.role === 'user').length
	let userTurnsSeen = 0
	let pendingInfos: string[] = []

	for (const entry of sliced) {
		currentModel = applyModelEvent(currentModel, entry)

		// Collect injected info entries for the next user message
		if (entry.type === 'info') {
			const turnsRemaining = totalUserTurns - userTurnsSeen
			const visibility = (entry as any).visibility ?? ((entry as any).level === 'error' ? 'next-user' : 'ui')
			if (visibility === 'next-user' && turnsRemaining <= apiConfig.injectTurnTtl) {
				pendingInfos.push(entry.text ?? '')
			}
			continue
		}

		// Skip non-message entries
		if (!entry.role) continue

		if (entry.role === 'user') {
			userTurnsSeen++
			const userContent = buildUserContent(sessionId, entry, pendingInfos)
			pendingInfos = []
			out.push({ role: 'user', content: userContent })
		} else if (entry.role === 'assistant') {
			pendingInfos = [] // discard infos not followed by user message
			const content = buildAssistantContent(sessionId, entry, currentModel)
			if (content.length > 0) {
				// Handle continuation: merge with previous assistant message
				if (entry.continuation && out.length > 0 && out[out.length - 1]!.role === 'assistant') {
					out[out.length - 1] = { role: 'assistant', content }
				} else {
					out.push({ role: 'assistant', content })
				}
			}
		} else if (entry.role === 'tool_result') {
			const resultContent = buildToolResultContent(sessionId, entry)
			out.push({ role: 'user', content: [resultContent] })
		}
	}

	// Ensure tool_use/tool_result pairing is correct.
	// Tool results may be displaced — relocate or synthesize missing ones.
	repairToolPairing(out)

	// Prune old heavy content to save context window space
	return pruneMessages(out)
}

// Build content for a user message, prepending any pending injected infos.
function buildUserContent(sessionId: string, entry: HistoryEntry, pendingInfos: string[]): string | ContentBlock[] {
	const time = formatLocalTime(entry.ts)
	const prefix = [
		...(time ? [`[${time}]`] : []),
		...pendingInfos,
	].join('\n')

	if (typeof entry.content === 'string') {
		return prefix ? prefix + '\n' + entry.content : entry.content
	}

	if (Array.isArray(entry.content)) {
		const blocks: ContentBlock[] = []
		if (prefix) blocks.push({ type: 'text', text: prefix })

		for (const b of entry.content) {
			if (b.type === 'image' && b.blobId) {
				// Load image data from blob
				const data = blob.readBlobFromChain(sessionId, b.blobId)
				if (data?.media_type && data?.data) {
					blocks.push({
						type: 'image',
						source: { type: 'base64', media_type: data.media_type, data: data.data },
					} as any)
				} else {
					blocks.push({ type: 'text', text: `[image unavailable — blob ${b.blobId}]` })
				}
			} else {
				blocks.push(b)
			}
		}
		return blocks
	}

	return prefix || ''
}

// Build content blocks for an assistant message.
function buildAssistantContent(sessionId: string, entry: HistoryEntry, currentModel?: string): ContentBlock[] {
	const content: ContentBlock[] = []

	// Thinking block — load from blob if needed
	let thinkingText = entry.thinkingText
	let thinkingSignature = entry.thinkingSignature
	if (entry.thinkingBlobId && (!thinkingText || !thinkingSignature)) {
		const blobData = blob.readBlobFromChain(sessionId, entry.thinkingBlobId)
		if (!thinkingText) thinkingText = blobData?.thinking
		if (!thinkingSignature) thinkingSignature = blobData?.signature
	}
	if (thinkingText && thinkingSignature) {
		content.push({ type: 'thinking', thinking: thinkingText, signature: thinkingSignature })
	}

	// Text response
	if (entry.text) content.push({ type: 'text', text: entry.text })

	// Tool calls — load input from blob
	if (Array.isArray(entry.tools)) {
		for (const t of entry.tools) {
			const blobData = blob.readBlobFromChain(sessionId, t.blobId)
			content.push({ type: 'tool_use', id: t.id, name: t.name, input: blobData?.call?.input ?? {} })
		}
	}

	return content
}

// Build a tool_result content block from a history entry.
function buildToolResultContent(sessionId: string, entry: HistoryEntry): ContentBlock {
	const blobData = blob.readBlobFromChain(sessionId, entry.blobId)
	let resultContent = blobData?.result?.content ?? '[interrupted]'

	// Truncate oversized tool results
	if (typeof resultContent === 'string' && resultContent.length > apiConfig.maxToolOutput) {
		const truncated = resultContent.length - apiConfig.maxToolOutput
		resultContent = resultContent.slice(0, apiConfig.maxToolOutput) + `\n[truncated ${truncated} chars]`
	}

	return { type: 'tool_result', tool_use_id: entry.tool_use_id, content: resultContent }
}

// ── Tool pairing repair ──

// Ensure every assistant message with tool_use blocks has matching tool_result
// entries immediately following it. Missing results get synthesized as [interrupted].
function repairToolPairing(msgs: Message[]): void {
	for (let i = 0; i < msgs.length; i++) {
		const msg = msgs[i]!
		if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue

		const toolUseIds = (msg.content as ContentBlock[]).filter((b) => b.type === 'tool_use').map((b) => b.id!)

		if (toolUseIds.length === 0) continue

		// Check which results exist in the next message
		const nextIdx = i + 1
		const haveIds = new Set<string>()
		if (nextIdx < msgs.length && msgs[nextIdx]!.role === 'user' && Array.isArray(msgs[nextIdx]!.content)) {
			for (const b of msgs[nextIdx]!.content as ContentBlock[]) {
				if (b.type === 'tool_result' && toolUseIds.includes(b.tool_use_id!)) {
					haveIds.add(b.tool_use_id!)
				}
			}
		}

		const missingIds = toolUseIds.filter((id) => !haveIds.has(id))
		if (missingIds.length === 0) continue

		// Search later messages for displaced tool_results, or synthesize them
		const collected: ContentBlock[] = []
		for (const id of missingIds) {
			let found = false
			for (let j = nextIdx; j < msgs.length && !found; j++) {
				if (msgs[j]!.role !== 'user' || !Array.isArray(msgs[j]!.content)) continue
				const blocks = msgs[j]!.content as ContentBlock[]
				const bIdx = blocks.findIndex((b) => b.type === 'tool_result' && b.tool_use_id === id)
				if (bIdx >= 0) {
					collected.push(blocks[bIdx]!)
					blocks.splice(bIdx, 1)
					found = true
				}
			}
			if (!found) {
				collected.push({ type: 'tool_result', tool_use_id: id, content: '[interrupted]' })
			}
		}

		// Insert collected results right after the assistant message
		if (haveIds.size > 0 && nextIdx < msgs.length) {
			;(msgs[nextIdx]!.content as ContentBlock[]).push(...collected)
		} else {
			msgs.splice(nextIdx, 0, { role: 'user', content: collected })
			i++ // skip the inserted message
		}
	}

	// Remove messages emptied by relocation
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (Array.isArray(msgs[i]!.content) && (msgs[i]!.content as ContentBlock[]).length === 0) {
			msgs.splice(i, 1)
		}
	}
}

// ── Context pruning ──

// True if this message ends a completed turn (assistant response with no tool_use).
function isTurnEnd(msg: any): boolean {
	if (msg.role !== 'assistant') return false
	if (!Array.isArray(msg.content)) return true
	return !(msg.content as any[]).some((b: any) => b.type === 'tool_use')
}

// Strip old tool results, tool inputs, images, and thinking from API messages.
// Keeps recent content intact, replaces old heavy content with placeholders.
function pruneMessages(msgs: Message[]): Message[] {
	const heavy = apiConfig.heavyThreshold
	const thinking = apiConfig.thinkingThreshold

	// Count completed turns after each position (how "old" each message is)
	const age = new Array(msgs.length).fill(0)
	let count = 0
	for (let i = msgs.length - 1; i >= 0; i--) {
		age[i] = count
		if (isTurnEnd(msgs[i]!)) count++
	}

	const out: Message[] = []
	for (let i = 0; i < msgs.length; i++) {
		const msg = msgs[i]!

		if (msg.role === 'assistant' && Array.isArray(msg.content)) {
			let content = (msg.content as ContentBlock[]).map((b) => {
				// Strip tool inputs from old messages
				if (b.type === 'tool_use' && age[i] > heavy) return { ...b, input: {} }
				return b
			})
			// Strip thinking from old messages
			if (age[i] > thinking) {
				content = content.filter((b) => b.type !== 'thinking')
			}
			out.push({ ...msg, content })
		} else if (msg.role === 'user' && Array.isArray(msg.content)) {
			const content = (msg.content as ContentBlock[]).map((b) => {
				// Strip old tool results
				if (b.type === 'tool_result' && age[i] > heavy) {
					return { ...b, content: '[tool result omitted from context]' }
				}
				// Strip old images
				if (b.type === 'image' && age[i] > heavy) {
					return { type: 'text' as const, text: '[image omitted from context]' }
				}
				return b
			})
			out.push({ ...msg, content })
		} else {
			out.push(msg)
		}
	}

	return out
}

export const apiMessages = {
	config: apiConfig,
	toAnthropicMessages,
	applyModelEvent,
	findReplayStart,
	formatLocalTime,
}
