import { models } from './models.ts'

// Shared live-block mutation rules.
//
// Both the client and session persistence maintain an in-memory block list that
// reflects live streaming state. The rules for how stream deltas, info notices,
// tool calls, and tool results mutate that list must stay identical, otherwise a
// freshly reloaded session diverges from what a live tab showed a moment earlier.
//
// This module owns that shared mutation logic. Callers can still add their own
// behavior around it, like client repaint policy or blob reloads.

function assistantChainId(block: any): string | null {
	if (block?.type !== 'assistant') return null
	return block.continue ?? block.id ?? null
}

function lastInterruptedAssistantId(blocks: any[]): string | null {
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i]
		if (!block || block.type === 'tool') continue
		if (block.type === 'info' || block.type === 'warning' || block.type === 'error') continue
		return block.type === 'assistant' ? assistantChainId(block) : null
	}
	return null
}

function closeStreamingBlock(blocks: any[], onChange?: () => void): boolean {
	const last = blocks[blocks.length - 1] ?? null
	if ((last?.type === 'assistant' || last?.type === 'thinking') && last.streaming) {
		delete last.streaming
		onChange?.()
		return true
	}
	return false
}

function makeAssistantId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

interface ApplyEventOptions {
	blocks: any[]
	event: any
	sessionId?: string
	defaultModel?: string
	touchBlock?: (block: any) => void
	onChange?: () => void
}

function applyEvent(opts: ApplyEventOptions): { changed: boolean; toolBlock?: any } {
	const { blocks, event, sessionId: fallbackSessionId, defaultModel, touchBlock, onChange } = opts
	if (!event?.type) return { changed: false }

	const sessionId = event.sessionId ?? fallbackSessionId
	const ts = event.createdAt ? Date.parse(event.createdAt) : undefined
	const close = () => closeStreamingBlock(blocks, onChange)
	const changed = () => {
		onChange?.()
		return { changed: true }
	}

	if (event.type === 'stream-start') return { changed: close() }

	if (event.type === 'stream-delta' && event.text) {
		const last = blocks[blocks.length - 1] ?? null
		if (event.channel === 'thinking') {
			if (last?.type === 'thinking' && last.streaming) {
				last.text += event.text
				if (event.blobId) last.blobId = event.blobId
				if (!last.sessionId && sessionId) last.sessionId = sessionId
				if (!last.ts) last.ts = ts
				if (!last.model) last.model = event.model ?? defaultModel
				if (!last.thinkingEffort) last.thinkingEffort = event.thinkingEffort ?? models.reasoningEffort(last.model)
				touchBlock?.(last)
				return changed()
			}
			close()
			blocks.push({
				type: 'thinking',
				text: event.text,
				model: event.model ?? defaultModel,
				thinkingEffort: event.thinkingEffort ?? models.reasoningEffort(event.model ?? defaultModel),
				blobId: event.blobId,
				sessionId,
				ts,
				streaming: true,
			})
			return changed()
		}

		if (last?.type === 'assistant' && last.streaming) {
			last.text += event.text
			if (!last.ts) last.ts = ts
			if (!last.model) last.model = event.model ?? defaultModel
			touchBlock?.(last)
			return changed()
		}

		close()
		blocks.push({
			type: 'assistant',
			text: event.text,
			model: event.model ?? defaultModel,
			id: lastInterruptedAssistantId(blocks) ? undefined : makeAssistantId(),
			continue: lastInterruptedAssistantId(blocks) ?? undefined,
			ts,
			streaming: true,
		})
		return changed()
	}

	if (event.type === 'tool-call') {
		close()
		blocks.push({
			type: 'tool',
			name: event.name,
			input: event.input,
			blobId: event.blobId,
			sessionId,
			toolId: event.toolId,
			ts,
		})
		return changed()
	}

	if (event.type === 'tool-result') {
		const toolBlock = blocks.findLast((block) => block?.type === 'tool' && block.toolId === event.toolId)
		if (!toolBlock) return { changed: false }
		toolBlock.output = event.output
		if (event.blobId) toolBlock.blobId = event.blobId
		touchBlock?.(toolBlock)
		onChange?.()
		return { changed: true, toolBlock }
	}

	if (event.type === 'info' && event.text) {
		close()
		blocks.push({ type: event.level === 'error' ? 'error' : 'info', text: event.text, ts })
		return changed()
	}

	if (event.type === 'response' && event.isError && event.text) {
		close()
		blocks.push({ type: 'error', text: event.text, blobId: event.blobId, sessionId, ts })
		return changed()
	}

	if (event.type === 'stream-end') return { changed: close() }
	return { changed: false }
}

export const liveEventBlocks = {
	assistantChainId,
	lastInterruptedAssistantId,
	closeStreamingBlock,
	applyEvent,
}
