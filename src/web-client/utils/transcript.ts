import type { HistoryEntry } from '../../common/history.ts'
import { historyProjection, type ProjectedQuestion } from '../../common/history-projection.ts'
import type { LiveBlock, LiveToolBlock } from '../../common/live-event-blocks.ts'
import type { ClientSessionSnapshot } from '../../common/snapshots.ts'
import { webProtocol } from '../../common/web.ts'

export type TranscriptEntry = HistoryEntry | LiveBlock | ProjectedQuestion

type ToolLike = {
	type?: string
	name?: string
	input?: unknown
	output?: unknown
	running?: boolean
}

export type RenderedTranscriptItem = {
	entry: TranscriptEntry
	text: string
}
function blockId(entry: TranscriptEntry): string {
	return 'blobId' in entry && entry.blobId || entry.id || ''
}

// Persisted IDs survive snapshots; the tool call ID also survives live -> saved.
function rowKey(item: RenderedTranscriptItem): string | TranscriptEntry {
	if (item.entry.type === 'tool' && item.entry.toolId) return `tool:${item.entry.toolId}`
	return item.entry.id || ('blobId' in item.entry && item.entry.blobId) || item.entry
}

function valueText(value: unknown): string {
	if (typeof value === 'string') return value
	if (value === undefined) return ''
	return JSON.stringify(value, null, 2)
}

function toolText(item: ToolLike): string {
	let call = ''
	if (item.input && typeof item.input === 'object') {
		const input = item.input as Record<string, unknown>
		if (typeof input.command === 'string') call = input.command
		else if (typeof input.code === 'string') call = input.code
	}
	if (!call && item.input !== undefined) call = valueText(item.input)
	const output = valueText(item.output)
	if (call && output) return `${call}\n\n${output}`
	return call || output
}

function historyItems(history: readonly HistoryEntry[], parentCount = 0): TranscriptEntry[] {
	const items: TranscriptEntry[] = []
	const tools = new Map<string, LiveToolBlock>()
	const projectedQuestions = new Map<string, ProjectedQuestion>()
	for (const question of historyProjection.questions([...history], parentCount)) projectedQuestions.set(question.id, question)
	for (const entry of history) {
		if (entry.type === 'question') {
			const question = projectedQuestions.get(entry.id)
			if (question) items.push(question)
			continue
		}
		if (entry.type === 'answer') continue
		if (entry.type === 'tool_call') {
			const tool: LiveToolBlock = {
				type: 'tool',
				id: entry.id,
				name: entry.name,
				input: entry.input,
				toolId: entry.toolId,
				blobId: entry.blobId,
				ts: entry.ts ? Date.parse(entry.ts) : undefined,
				canceled: entry.canceled,
			}
			items.push(tool)
			tools.set(entry.toolId, tool)
			continue
		}
		if (entry.type === 'tool_result') {
			const tool = tools.get(entry.toolId)
			if (!tool) {
				items.push(entry)
				continue
			}
			if (entry.output !== undefined) tool.output = valueText(entry.output)
			if (entry.blobId && !tool.blobId && !tool.id) tool.blobId = entry.blobId
			if (entry.canceled) tool.canceled = true
			continue
		}
		items.push(entry)
	}
	return items
}

function entryText(entry: TranscriptEntry): string {
	if (entry.type === 'question') return entry.text
	if (entry.type === 'user') {
		if (typeof entry.text === 'string') return entry.text
		return historyProjection.userText(entry, { images: 'path-or-image', display: 'ui' })
	}
	if (entry.type === 'thinking') return entry.text ?? ''
	if (entry.type === 'tool' || entry.type === 'tool_call' || entry.type === 'tool_result') return toolText(entry)
	if (entry.type === 'info' || entry.type === 'log') return historyProjection.noticeText(entry.text)
	if (entry.type === 'assistant' || entry.type === 'warning' || entry.type === 'error' || entry.type === 'fork') return typeof entry.text === 'string' ? entry.text : ''
	return ''
}


function interruption(entry: TranscriptEntry): string | undefined {
	if ((entry.type !== 'assistant' && entry.type !== 'thinking') || !entry.interruptedBy) return undefined
	return historyProjection.interruptionText(entry.interruptedBy)
}
function imageHref(sessionId: string, blobId: string, token: string): string {
	const path = webProtocol.imagePath(sessionId, blobId)
	return path ? `${path}?auth=${encodeURIComponent(token)}` : ''
}
function pastedText(entry: TranscriptEntry): string {
	if (entry.type !== 'user' || !('parts' in entry) || !entry.parts) return ''
	for (const part of entry.parts) {
		if (part.type !== 'text' || !part.displayText) continue
		const marker = /\[\/tmp\/hal\/paste\/\d+\.txt\]/.exec(part.displayText)
		if (!marker) continue
		const before = part.displayText.slice(0, marker.index)
		const after = part.displayText.slice(marker.index + marker[0].length)
		if (part.text.startsWith(before) && part.text.endsWith(after)) return part.text.slice(before.length, part.text.length - after.length)
		return part.text
	}
	return ''
}
function pasteSegments(text: string): string[] {
	return text.split(/(\[\/tmp\/hal\/paste\/\d+\.txt\])/g).filter(Boolean)
}

function isPasteMarker(text: string): boolean {
	return /^\[\/tmp\/hal\/paste\/\d+\.txt\]$/.test(text)
}

function items(snapshot: ClientSessionSnapshot | null): RenderedTranscriptItem[] {
	if (!snapshot) return []
	const result: RenderedTranscriptItem[] = []
	for (const entry of historyItems(snapshot.history, snapshot.parentCount)) {
		const text = entryText(entry)
		if (text) result.push({ entry, text })
	}
	for (const entry of snapshot.live) {
		const text = entryText(entry)
		if (text) result.push({ entry, text })
	}
	return result
}

function activeCursorEntry(items: RenderedTranscriptItem[]): TranscriptEntry | undefined {
	for (const item of [...items].reverse()) {
		if ((item.entry.type === 'thinking' || item.entry.type === 'assistant') && 'streaming' in item.entry && item.entry.streaming) return item.entry
	}
}

export const webTranscript = { valueText, toolText, historyItems, interruption, items, imageHref, pastedText, pasteSegments, isPasteMarker, blockId, rowKey, activeCursorEntry }
