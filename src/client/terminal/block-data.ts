// Block data model — converts history records to Block objects and hydrates
// tool/thinking blocks from blob sidecar files. Rendering lives in blocks.ts.
//
// A single assistant history record can produce multiple blocks:
//   thinking → tool₁ → tool₂ → assistant text

import { ason } from '../../utils/ason.ts'
import { models } from '../../common/models.ts'
import type { LiveBlock } from '../../common/live-event-blocks.ts'
import type { HistoryEntry } from '../../server/sessions.ts'
import { sessionEntry } from '../../server/session/entry.ts'
import { STATE_DIR } from '../../state.ts'
// Sibling import for blocks.config; circular with blocks.ts but safe per
// module convention — all access happens at call time, never at import time.
import { blocks } from './blocks.ts'

interface PresentationBlock {
	dimmed?: boolean
	renderVersion?: number
	blobLoaded?: boolean
}

export type Block = LiveBlock & PresentationBlock

function touch(block: Block): void {
	block.renderVersion = (block.renderVersion ?? 0) + 1
}

function parseTs(ts?: string): number | undefined {
	return ts ? Date.parse(ts) : undefined
}

function blobPath(sessionId: string, blobId: string): string {
	return `${STATE_DIR}/sessions/${sessionId}/blobs/${blobId}.ason`
}

function historyToBlocks(
	history: HistoryEntry[],
	sessionId: string,
	parentEntryCount = 0,
	parentId?: string,
	initialModel?: string,
): Block[] {
	const result: Block[] = []
	for (let i = 0; i < history.length; i++) {
		const entry = history[i]!
		const ts = parseTs(entry.ts)
		const dimmed = i < parentEntryCount ? true : undefined
		const blobOwner = i < parentEntryCount && parentId ? parentId : sessionId
		switch (entry.type) {
			case 'user': {
				const text = sessionEntry.userText(entry, { images: 'path-or-image', display: 'ui' })
				const actualText = sessionEntry.userText(entry, { images: 'path-or-image' })
				if (!text) break
				const isSystem = text.startsWith('[system] ')
				const displayText = isSystem ? text.slice(9) : text
				const editText = isSystem && actualText.startsWith('[system] ') ? actualText.slice(9) : actualText
				result.push({
					type: 'user',
					text: displayText,
					actualText: editText === displayText ? undefined : editText,
					source: isSystem ? 'system' : entry.source ?? undefined,
					status: entry.status,
					sourceTab: entry.sourceTab,
					ts,
					dimmed,
					canceled: entry.canceled,
				})
				break
			}
			case 'thinking': {
				const model = entry.model ?? initialModel
				result.push({
					type: 'thinking',
					text: entry.text ?? '',
					model,
					thinkingEffort: entry.thinkingEffort ?? models.reasoningEffort(model),
					blobId: entry.blobId,
					sessionId: blobOwner,
					ts,
					dimmed,
					canceled: entry.canceled,
				})
				break
			}
			case 'tool_call':
				result.push({ type: 'tool', name: entry.name, input: entry.input, blobId: entry.blobId, sessionId: blobOwner, toolId: entry.toolId, ts, dimmed, canceled: entry.canceled })
				break
			case 'pending_tools':
				if (!entry.canceled) result.push({ type: 'log', text: '[paused before local tools]', ts, dimmed })
				break
			case 'assistant':
				result.push({
					type: 'assistant',
					text: entry.text,
					model: entry.model ?? initialModel,
					synthetic: entry.synthetic,
					syntheticKind: entry.syntheticKind,
					ts,
					dimmed,
					canceled: entry.canceled,
				})
				break
			case 'log':
				result.push({ type: entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'log', text: entry.text, ts, dimmed, usageBars: entry.usageBars })
				break
			case 'info':
				result.push({ type: 'info', text: entry.text, ts, dimmed, usageBars: entry.usageBars })
				break
			case 'warning':
				result.push({ type: 'warning', text: entry.text, ts, dimmed })
				break
			case 'error':
				result.push({ type: 'error', text: entry.text, blobId: entry.blobId, sessionId: blobOwner, ts, dimmed })
				break
			case 'turn_end':
				if (entry.status === 'failed' && result.at(-1)?.type !== 'error') result.push({ type: 'error', text: 'Generation failed.', ts, dimmed })
				if (entry.status === 'aborted' && entry.abortText !== '') result.push({ type: 'log', text: entry.abortText ?? '[paused]', ts, dimmed })
				break
			case 'forked_from':
				result.push({ type: 'fork', text: `Tab forked from ${entry.parent}.`, ts, dimmed })
				break
			case 'forked_to':
				result.push({ type: 'fork', text: `Tab forked to ${entry.child}.`, ts, dimmed })
				break
			case 'rebased_from':
			case 'rebased_to':
				// These link immutable history files for auditing; they are not
				// chronological conversation events. Explicit /rebase separately
				// reports completion at the point where the user performed it.
				break
			case 'cwd':
				result.push({ type: 'info', text: `cwd: ${entry.from} -> ${entry.to}`, ts, dimmed })
				break
			case 'model':
				result.push({ type: 'info', text: `model: ${entry.from} -> ${entry.to}`, ts, dimmed })
				break
		}
	}
	return result
}

function parseBlob(text: string): any | null {
	try {
		return ason.parse(text)
	} catch {
		return null
	}
}

function applyToolBlob(block: Extract<Block, { type: 'tool' }>, text: string): void {
	block.blobLoaded = true
	const blob = parseBlob(text)
	if (!blob) return
	block.input = blob?.call?.input
	if (typeof blob?.result?.content === 'string') block.output = blob.result.content
	touch(block)
}

function applyThinkingBlob(block: Extract<Block, { type: 'thinking' }>, text: string): void {
	block.blobLoaded = true
	const blob = parseBlob(text)
	if (!blob || typeof blob?.thinking !== 'string') return
	block.text = blob.thinking
	touch(block)
}

const MAX_BLOB_SIZE = 1024 * 1024

type BlobBlock = Extract<Block, { type: 'tool' | 'thinking' }>

async function loadBlobs(items: Block[]): Promise<number> {
	const pending = items.filter(
		(block): block is BlobBlock =>
			(block.type === 'tool' || block.type === 'thinking') && !block.blobLoaded && !!block.blobId,
	)
	if (pending.length === 0) return 0
	for (let i = 0; i < pending.length; i += blocks.config.blobBatchSize) {
		const batch = pending.slice(i, i + blocks.config.blobBatchSize)
		const files = batch.map((block) => Bun.file(blobPath(block.sessionId ?? '', block.blobId!)))
		const sizes = await Promise.allSettled(files.map((file) => file.size))
		const reads = files.map((file, index) => {
			const size = sizes[index]!
			return size.status === 'fulfilled' && size.value <= MAX_BLOB_SIZE ? file.text() : Promise.resolve(null)
		})
		const results = await Promise.allSettled(reads)
		for (let j = 0; j < batch.length; j++) {
			const result = results[j]!
			const block = batch[j]!
			if (result.status === 'fulfilled' && result.value !== null) {
				if (block.type === 'tool') applyToolBlob(block, result.value)
				else applyThinkingBlob(block, result.value)
			} else {
				block.blobLoaded = true
			}
		}
		await Bun.sleep(0)
	}
	return pending.length
}

export const blockData = {
	historyToBlocks,
	touch,
	loadBlobs,
}
