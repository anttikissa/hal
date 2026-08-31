import { models } from './models.ts'

// Browser-safe semantic blocks produced from live server events. Terminal and web
// clients can enrich or render these blocks independently, but they share this
// projection so a snapshot and a live event stream always converge.
export interface LiveBlockBase {
	id?: string
	ts?: number
	canceled?: boolean
	usageBars?: true
}

export interface LiveUserBlock extends LiveBlockBase {
	type: 'user'
	text: string
	actualText?: string
	source?: string
	status?: string
	sourceTab?: number
	sourceName?: string
}

export interface LiveAssistantBlock extends LiveBlockBase {
	type: 'assistant'
	text: string
	model?: string
	streaming?: boolean
	synthetic?: boolean
	syntheticKind?: string
	sessionId?: string
}

export interface LiveThinkingBlock extends LiveBlockBase {
	type: 'thinking'
	text: string
	model?: string
	thinkingEffort?: string
	streaming?: boolean
	blobId?: string
	sessionId?: string
}

export interface LiveToolBlock extends LiveBlockBase {
	type: 'tool'
	name: string
	input?: unknown
	output?: string
	blobId?: string
	sessionId?: string
	toolId?: string
	running?: boolean
}

export interface LiveNoticeBlock extends LiveBlockBase {
	type: 'log' | 'info' | 'warning'
	text: string
}

export interface LiveErrorBlock extends LiveBlockBase {
	type: 'error'
	text: string
	blobId?: string
	sessionId?: string
}

export interface LiveForkBlock extends LiveBlockBase {
	type: 'fork'
	text: string
}

export type LiveBlock = LiveUserBlock | LiveAssistantBlock | LiveThinkingBlock | LiveToolBlock | LiveNoticeBlock | LiveErrorBlock | LiveForkBlock

export interface LiveEventBase {
	type: string
	id?: string
	sessionId?: string
	createdAt?: string
}

export interface PromptEvent extends LiveEventBase {
	type: 'prompt'
	text: string
	actualText?: string
	label?: 'steering' | 'queued'
	source?: string
	sourceTab?: number
	sourceName?: string
}

export interface StreamStartEvent extends LiveEventBase {
	type: 'stream-start'
}

export interface StreamDeltaEvent extends LiveEventBase {
	type: 'stream-delta'
	channel: 'assistant' | 'thinking'
	text?: string
	model?: string
	thinkingEffort?: string
	blobId?: string
}

export interface StreamEndEvent extends LiveEventBase {
	type: 'stream-end'
	phase?: 'done' | 'failed'
	usage?: { input: number; output: number; cacheRead?: number; cacheCreation?: number }
	contextUsed?: number
	contextMax?: number
	message?: string
}

export interface ToolCallEvent extends LiveEventBase {
	type: 'tool-call'
	toolId?: string
	name: string
	input?: unknown
	blobId?: string
	phase?: 'running'
}

export interface ToolResultEvent extends LiveEventBase {
	type: 'tool-result'
	toolId?: string
	output?: string
	blobId?: string
	name?: string
	phase?: 'running' | 'done'
}

export interface InfoEvent extends LiveEventBase {
	type: 'info'
	text?: string
	level?: 'info' | 'warning' | 'error'
	ui?: 'notice'
	usageBars?: boolean
}

export interface ResponseEvent extends LiveEventBase {
	type: 'response'
	text?: string
	model?: string
	synthetic?: boolean
	isError?: boolean
	blobId?: string
}

export type LiveEvent = PromptEvent | StreamStartEvent | StreamDeltaEvent | StreamEndEvent | ToolCallEvent | ToolResultEvent | InfoEvent | ResponseEvent

export interface LiveProjectionOptions {
	sessionId?: string
	defaultModel?: string
}

export interface LiveProjectionResult {
	blocks: LiveBlock[]
	changed: boolean
	toolBlock?: LiveToolBlock
}


function closeStreamingBlock(blocks: readonly LiveBlock[]): LiveProjectionResult {
	const last = blocks.at(-1)
	if ((last?.type !== 'assistant' && last?.type !== 'thinking') || !last.streaming) {
		return { blocks: blocks as LiveBlock[], changed: false }
	}
	const closed = { ...last }
	delete closed.streaming
	const next = blocks.slice()
	next[next.length - 1] = closed
	return { blocks: next, changed: true }
}


function timestamp(event: LiveEventBase): number | undefined {
	return event.createdAt ? Date.parse(event.createdAt) : undefined
}

function appendBlock<T extends { id?: string }>(blocks: readonly T[], block: T): { blocks: T[]; changed: true } {
	const index = block.id ? blocks.findIndex((item) => item.id === block.id) : -1
	if (index < 0) return { blocks: [...blocks, block], changed: true }
	const next = blocks.slice()
	next[index] = block
	return { blocks: next, changed: true }
}


function reduce(blocks: readonly LiveBlock[], event: LiveEvent, options: LiveProjectionOptions = {}): LiveProjectionResult {
	const sessionId = event.sessionId ?? options.sessionId
	const ts = liveEventBlocks.timestamp(event)

	if (event.type === 'prompt') {
		const closed = liveEventBlocks.closeStreamingBlock(blocks).blocks
		const block: LiveUserBlock = { type: 'user', text: event.text }
		if (event.id) block.id = event.id
		if (event.actualText) block.actualText = event.actualText
		if (event.source) block.source = event.source
		if (event.sourceTab !== undefined) block.sourceTab = event.sourceTab
		if (event.sourceName) block.sourceName = event.sourceName
		if (event.label) block.status = event.label
		if (ts !== undefined) block.ts = ts
		return liveEventBlocks.appendBlock(closed, block)
	}

	if (event.type === 'stream-start') return liveEventBlocks.closeStreamingBlock(blocks)

	if (event.type === 'stream-delta' && event.text) {
		const last = blocks.at(-1)
		if (event.channel === 'thinking') {
			if (last?.type === 'thinking' && last.streaming) {
				const updated: LiveThinkingBlock = { ...last, text: last.text + event.text }
				if (event.blobId) updated.blobId = event.blobId
				if (!updated.sessionId && sessionId) updated.sessionId = sessionId
				if (!updated.ts && ts !== undefined) updated.ts = ts
				if (!updated.model && (event.model ?? options.defaultModel)) updated.model = event.model ?? options.defaultModel
				if (!updated.thinkingEffort) updated.thinkingEffort = event.thinkingEffort ?? models.reasoningEffort(updated.model)
				const next = blocks.slice()
				next[next.length - 1] = updated
				return { blocks: next, changed: true }
			}
			const closed = liveEventBlocks.closeStreamingBlock(blocks).blocks
			const model = event.model ?? options.defaultModel
			const block: LiveThinkingBlock = { type: 'thinking', text: event.text, streaming: true }
			if (model) block.model = model
			const effort = event.thinkingEffort ?? models.reasoningEffort(model)
			if (effort) block.thinkingEffort = effort
			if (event.blobId) block.blobId = event.blobId
			if (sessionId) block.sessionId = sessionId
			if (ts !== undefined) block.ts = ts
			return liveEventBlocks.appendBlock(closed, block)
		}

		if (last?.type === 'assistant' && last.streaming) {
			const updated: LiveAssistantBlock = { ...last, text: last.text + event.text }
			if (!updated.ts && ts !== undefined) updated.ts = ts
			if (!updated.model && (event.model ?? options.defaultModel)) updated.model = event.model ?? options.defaultModel
			const next = blocks.slice()
			next[next.length - 1] = updated
			return { blocks: next, changed: true }
		}

		const closed = liveEventBlocks.closeStreamingBlock(blocks).blocks
		const block: LiveAssistantBlock = { type: 'assistant', text: event.text, streaming: true }
		const model = event.model ?? options.defaultModel
		if (model) block.model = model
		if (ts !== undefined) block.ts = ts
		return liveEventBlocks.appendBlock(closed, block)
	}

	if (event.type === 'tool-call') {
		const closed = liveEventBlocks.closeStreamingBlock(blocks).blocks
		const block: LiveToolBlock = { type: 'tool', name: event.name, running: true }
		if (event.input !== undefined) block.input = event.input
		if (event.blobId) block.blobId = event.blobId
		if (sessionId) block.sessionId = sessionId
		if (event.toolId) block.toolId = event.toolId
		if (ts !== undefined) block.ts = ts
		return liveEventBlocks.appendBlock(closed, block)
	}

	if (event.type === 'tool-result') {
		const index = blocks.findLastIndex((block) => block.type === 'tool' && block.toolId === event.toolId)
		const existing = blocks[index]
		if (existing?.type !== 'tool') return { blocks: blocks as LiveBlock[], changed: false }
		const toolBlock: LiveToolBlock = { ...existing }
		if (event.output !== undefined) toolBlock.output = event.output
		if (event.phase === 'running') toolBlock.running = true
		else delete toolBlock.running
		if (event.blobId) toolBlock.blobId = event.blobId
		const next = blocks.slice()
		next[index] = toolBlock
		return { blocks: next, changed: true, toolBlock }
	}

	if (event.type === 'info' && event.text) {
		const closed = liveEventBlocks.closeStreamingBlock(blocks).blocks
		const type = liveEventBlocks.infoBlockType(event)
		if (type === 'error') {
			const block: LiveErrorBlock = { type, text: event.text }
			if (ts !== undefined) block.ts = ts
			return liveEventBlocks.appendBlock(closed, block)
		}
		const block: LiveNoticeBlock = { type, text: event.text }
		if (event.usageBars === true) block.usageBars = true
		if (ts !== undefined) block.ts = ts
		return liveEventBlocks.appendBlock(closed, block)
	}

	if (event.type === 'response' && event.text) {
		if (event.isError) {
			const closed = liveEventBlocks.closeStreamingBlock(blocks).blocks
			const block: LiveErrorBlock = { type: 'error', text: event.text }
			if (event.blobId) block.blobId = event.blobId
			if (sessionId) block.sessionId = sessionId
			if (ts !== undefined) block.ts = ts
			return liveEventBlocks.appendBlock(closed, block)
		}
		const closed = liveEventBlocks.closeStreamingBlock(blocks).blocks
		const block: LiveAssistantBlock = { type: 'assistant', text: event.text, synthetic: event.synthetic === true }
		const model = event.model ?? options.defaultModel
		if (model) block.model = model
		if (sessionId) block.sessionId = sessionId
		if (ts !== undefined) block.ts = ts
		return liveEventBlocks.appendBlock(closed, block)
	}

	if (event.type === 'stream-end') {
		const closed = liveEventBlocks.closeStreamingBlock(blocks)
		const next = closed.blocks.map((block) => {
			if (block.type !== 'tool' || !block.running) return block
			const finished = { ...block }
			delete finished.running
			return finished
		})
		return { blocks: next, changed: closed.changed || next.some((block, index) => block !== closed.blocks[index]) }
	}
	return { blocks: blocks as LiveBlock[], changed: false }
}

function infoBlockType(event: InfoEvent): 'log' | 'info' | 'warning' | 'error' {
	if (event.ui === 'notice') return 'info'
	if (event.level === 'error') return 'error'
	if (event.level === 'warning') return 'warning'
	return 'log'
}

export const liveEventBlocks = {
	closeStreamingBlock,
	timestamp,
	appendBlock,
	reduce,
	infoBlockType,
}
