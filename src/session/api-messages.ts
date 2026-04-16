// Rebuild provider-neutral Message[] values from the flat on-disk history.
// Provider-specific repair and pruning stays here so the stored history format
// can remain simple and UI-oriented.

import type { HistoryEntry } from '../server/sessions.ts'
import { sessions } from '../server/sessions.ts'
import type { Message, ContentBlock } from '../protocol.ts'
import { blob } from './blob.ts'
import { sessionEntry } from './entry.ts'

function formatLocalTime(ts?: string): string | null {
	if (!ts) return null
	try {
		const d = new Date(ts)
		if (isNaN(d.getTime())) return null
		const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
		const date = d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })
		return `${date} ${time}`
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
	// Only rewrite old history every N completed turns to avoid constant cache busting
	pruneBatchTurns: 8,
}

function findReplayStart(entries: HistoryEntry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!
		if (e.type === 'reset' || e.type === 'compact') return i + 1
	}
	return 0
}

function toProviderMessages(sessionId: string, allEntries?: HistoryEntry[], opts?: { prune?: boolean }): Message[] {
	const entries = allEntries ?? sessions.loadAllHistory(sessionId)
	const start = findReplayStart(entries)
	const sliced = entries.slice(start)
	const out: Message[] = []

	const totalUserTurns = sliced.filter((entry) => entry.type === 'user').length
	let userTurnsSeen = 0
	let pendingInfos: string[] = []
	let pendingAssistant: ContentBlock[] = []
	let pendingToolResults: ContentBlock[] = []

	function flushAssistant(): void {
		if (pendingAssistant.length === 0) return
		out.push({ role: 'assistant', content: pendingAssistant })
		pendingAssistant = []
	}

	function flushToolResults(): void {
		if (pendingToolResults.length === 0) return
		out.push({ role: 'user', content: pendingToolResults })
		pendingToolResults = []
	}

	for (const entry of sliced) {
		if (entry.type === 'info') {
			const turnsRemaining = totalUserTurns - userTurnsSeen
			const visibility = entry.visibility ?? (entry.level === 'error' ? 'next-user' : 'ui')
			if (visibility === 'next-user' && turnsRemaining <= apiConfig.injectTurnTtl) {
				pendingInfos.push(entry.text)
			}
			continue
		}

		switch (entry.type) {
			case 'user': {
				flushAssistant()
				flushToolResults()
				userTurnsSeen++
				out.push({ role: 'user', content: buildUserContent(sessionId, entry, pendingInfos) })
				pendingInfos = []
				break
			}
			case 'thinking': {
				flushToolResults()
				pendingInfos = []
				const block = buildThinkingContent(sessionId, entry)
				if (block) pendingAssistant.push(block)
				break
			}
			case 'assistant': {
				flushToolResults()
				pendingInfos = []
				pendingAssistant.push({ type: 'text', text: entry.text })
				break
			}
			case 'tool_call': {
				flushToolResults()
				pendingInfos = []
				pendingAssistant.push(buildToolUseContent(sessionId, entry))
				break
			}
			case 'tool_result': {
				flushAssistant()
				pendingToolResults.push(buildToolResultContent(sessionId, entry))
				break
			}
			default:
				break
		}
	}

	flushAssistant()
	flushToolResults()
	repairToolPairing(out)
	return opts?.prune === false ? out : pruneMessages(out)
}

function buildUserContent(
	sessionId: string,
	entry: Extract<HistoryEntry, { type: 'user' }>,
	pendingInfos: string[],
): string | ContentBlock[] {
	const time = formatLocalTime(entry.ts)
	const prefix = [
		...(time ? [`[${time}]`] : []),
		...(entry.source ? [`[Inbox · ${entry.source}]`] : []),
		...pendingInfos,
	].join('\n')

	const onlyText = entry.parts.every((part) => part.type === 'text')
	if (onlyText) {
		const text = sessionEntry.userText(entry)
		return prefix ? `${prefix}\n${text}` : text
	}

	const blocks: ContentBlock[] = []
	if (prefix) blocks.push({ type: 'text', text: prefix })
	for (const part of entry.parts) {
		if (part.type === 'text') {
			blocks.push({ type: 'text', text: part.text })
			continue
		}
		const data = blob.readBlobFromChain(sessionId, part.blobId)
		if (data?.media_type && data?.data) {
			blocks.push({
				type: 'image',
				source: { type: 'base64', media_type: data.media_type, data: data.data },
			} as any)
		} else {
			blocks.push({ type: 'text', text: `[image unavailable — blob ${part.blobId}]` })
		}
	}
	return blocks
}

function buildThinkingContent(
	sessionId: string,
	entry: Extract<HistoryEntry, { type: 'thinking' }>,
): ContentBlock | null {
	let thinkingText = entry.text
	let thinkingSignature = entry.signature
	if (!thinkingText || !thinkingSignature) {
		const blobData = sessionEntry.loadEntryBlob(sessionId, entry)
		if (!thinkingText) thinkingText = blobData?.thinking
		if (!thinkingSignature) thinkingSignature = blobData?.signature
	}
	if (!thinkingText || !thinkingSignature) return null
	return { type: 'thinking', thinking: thinkingText, signature: thinkingSignature }
}

function buildToolUseContent(sessionId: string, entry: Extract<HistoryEntry, { type: 'tool_call' }>): ContentBlock {
	let input = entry.input
	const blobData = sessionEntry.loadEntryBlob(sessionId, entry)
	if (input === undefined) input = blobData?.call?.input ?? {}
	return { type: 'tool_use', id: entry.toolId, name: entry.name, input: input ?? {} }
}

function buildToolResultContent(
	sessionId: string,
	entry: Extract<HistoryEntry, { type: 'tool_result' }>,
): ContentBlock {
	let resultContent = entry.output
	const blobData = sessionEntry.loadEntryBlob(sessionId, entry)
	if (resultContent === undefined) resultContent = blobData?.result?.content ?? '[interrupted]'
	if (resultContent === undefined) resultContent = '[interrupted]'
	if (typeof resultContent === 'string' && resultContent.length > apiConfig.maxToolOutput) {
		const truncated = resultContent.length - apiConfig.maxToolOutput
		resultContent = resultContent.slice(0, apiConfig.maxToolOutput) + `\n[truncated ${truncated} chars]`
	}
	return { type: 'tool_result', tool_use_id: entry.toolId, content: resultContent }
}

function repairToolPairing(msgs: Message[]): void {
	for (let i = 0; i < msgs.length; i++) {
		const msg = msgs[i]!
		if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue

		const toolUseIds = (msg.content as ContentBlock[]).filter((b) => b.type === 'tool_use').map((b) => b.id!)
		if (toolUseIds.length === 0) continue

		const nextIdx = i + 1
		const haveIds = new Set<string>()
		if (nextIdx < msgs.length && msgs[nextIdx]!.role === 'user' && Array.isArray(msgs[nextIdx]!.content)) {
			for (const b of msgs[nextIdx]!.content as ContentBlock[]) {
				if (b.type === 'tool_result' && toolUseIds.includes(b.tool_use_id!)) haveIds.add(b.tool_use_id!)
			}
		}

		const missingIds = toolUseIds.filter((id) => !haveIds.has(id))
		if (missingIds.length === 0) continue

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
			if (!found) collected.push({ type: 'tool_result', tool_use_id: id, content: '[interrupted]' })
		}

		if (haveIds.size > 0 && nextIdx < msgs.length) {
			;(msgs[nextIdx]!.content as ContentBlock[]).push(...collected)
		} else {
			msgs.splice(nextIdx, 0, { role: 'user', content: collected })
			i++
		}
	}

	for (let i = msgs.length - 1; i >= 0; i--) {
		if (Array.isArray(msgs[i]!.content) && (msgs[i]!.content as ContentBlock[]).length === 0) msgs.splice(i, 1)
	}
}

function isTurnEnd(msg: Message): boolean {
	if (msg.role !== 'assistant') return false
	if (!Array.isArray(msg.content)) return true
	return !(msg.content as any[]).some((b: any) => b.type === 'tool_use')
}

function pastBatchThreshold(age: number, threshold: number): boolean {
	if (age <= threshold) return false
	const batch = Math.max(1, apiConfig.pruneBatchTurns)
	const firstBatch = Math.ceil((threshold + 1) / batch) * batch
	return age >= firstBatch
}

function pruneMessages(msgs: Message[]): Message[] {
	const heavy = apiConfig.heavyThreshold
	const thinking = apiConfig.thinkingThreshold

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
				if (b.type === 'tool_use' && pastBatchThreshold(age[i]!, heavy)) return { ...b, input: {} }
				return b
			})
			if (pastBatchThreshold(age[i]!, thinking)) content = content.filter((b) => b.type !== 'thinking')
			out.push({ ...msg, content })
		} else if (msg.role === 'user' && Array.isArray(msg.content)) {
			const content = (msg.content as ContentBlock[]).map((b) => {
				if (b.type === 'tool_result' && pastBatchThreshold(age[i]!, heavy))
					return { ...b, content: '[tool result omitted from context]' }
				if (b.type === 'image' && pastBatchThreshold(age[i]!, heavy))
					return { type: 'text' as const, text: '[image omitted from context]' }
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
	toProviderMessages,
	pruneMessages,
	findReplayStart,
	formatLocalTime,
}
