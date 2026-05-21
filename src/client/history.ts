import type { Block } from '../cli/blocks.ts'
import { liveEventBlocks } from '../live-event-blocks.ts'
import { ason } from '../utils/ason.ts'

interface LiveTab {
	liveHistory?: Block[]
}

function sameMergeTs(a?: number, b?: number): boolean {
	// Persisted history and live.ason often agree on timestamps, but some callers
	// only have one side. Missing ts should not block dedupe.
	return a == null || b == null || a === b
}

function sameMergeBlock(a: Block, b: Block): boolean {
	if (a.type !== b.type) return false
	if (!sameMergeTs(a.ts, b.ts)) return false

	if (a.type === 'tool' && b.type === 'tool') {
		const sameBlob = a.blobId == null || b.blobId == null || a.blobId === b.blobId
		return sameBlob && a.name === b.name && ason.stringify(a.input ?? null) === ason.stringify(b.input ?? null)
	}
	if (a.type === 'thinking' && b.type === 'thinking') {
		const sameBlob = a.blobId == null || b.blobId == null || a.blobId === b.blobId
		return sameBlob && a.text === b.text
	}
	if (a.type === 'error' && b.type === 'error') {
		const sameBlob = a.blobId == null || b.blobId == null || a.blobId === b.blobId
		return sameBlob && a.text === b.text
	}
	return 'text' in a && 'text' in b && a.text === b.text
}

function trimPersistedLiveOverlap(blocks: Block[], live: Block[]): Block[] {
	const maxOverlap = Math.min(blocks.length, live.length)
	for (let overlap = maxOverlap; overlap > 0; overlap--) {
		let matches = true
		for (let i = 0; i < overlap; i++) {
			const historyBlock = blocks[blocks.length - overlap + i]!
			const liveBlock = live[i]!
			if (sameMergeBlock(historyBlock, liveBlock)) continue
			matches = false
			break
		}
		if (matches) return live.slice(overlap)
	}
	return live
}

function withLive(blocks: Block[], tab: LiveTab): Block[] {
	const live = trimPersistedLiveOverlap(blocks, tab.liveHistory ?? [])
	if (live.length === 0) return blocks
	return [...blocks, ...live]
}

function hasTrailingAssistantText(blocks: Block[], text: string): boolean {
	const parts: string[] = []
	let chainId: string | null = null
	let sawAssistant = false
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i]!
		if (block.type === 'tool') continue
		if (block.type === 'log' || block.type === 'info' || block.type === 'warning' || block.type === 'error') {
			if (!sawAssistant) continue
			continue
		}
		if (block.type !== 'assistant') break
		const blockChainId = liveEventBlocks.assistantChainId(block)
		if (!sawAssistant) {
			sawAssistant = true
			chainId = blockChainId
			// Final response events may contain only the latest post-tool segment,
			// while the visible assistant text is linked as one continuation chain.
			if (block.text === text) return true
			parts.unshift(block.text)
			continue
		}
		if (chainId && blockChainId === chainId) {
			parts.unshift(block.text)
			continue
		}
		break
	}
	return sawAssistant && parts.join('') === text
}

export const clientHistory = {
	sameMergeTs,
	sameMergeBlock,
	trimPersistedLiveOverlap,
	withLive,
	hasTrailingAssistantText,
}
