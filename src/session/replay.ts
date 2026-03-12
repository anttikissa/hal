// Replay — convert messages to Block[] for TUI history display.

import type { Block } from '../cli/blocks.ts'
import type { Message } from './history.ts'
import { history as sessionHistory } from './history.ts'
import { blob } from './blob.ts'
import { tools } from '../runtime/tools.ts'

export const replayConfig = {
	blobReadConcurrency: 16,
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const cap = Math.max(1, Math.floor(limit) || 1)
	const out = new Array<R>(items.length)
	let next = 0
	const run = async () => {
		for (;;) {
			const idx = next
			next += 1
			if (idx >= items.length) return
			out[idx] = await worker(items[idx], idx)
		}
	}
	await Promise.all(Array.from({ length: Math.min(cap, items.length) }, () => run()))
	return out
}

/** Convert a message log to display blocks (for tab history). */
export async function replayToBlocks(sessionId: string, messages: Message[], model?: string, busy = false): Promise<Block[]> {
	const blocks: Block[] = []

	// Collect tool_result entries for matching
	const toolResults = new Map<string, string>()
	for (const msg of messages) {
		const m = msg as any
		if (m.role === 'tool_result') toolResults.set(m.tool_use_id, m.blobId)
	}

	for (const msg of messages) {
		const m = msg as any
		if (m.type === 'reset' || m.type === 'forked_from' || m.type === 'compact') continue
		if (m.type === 'session') {
			if (m.action === 'init') blocks.push({ type: 'info', text: `[session] ${m.model} in ${m.cwd}` })
			else if (m.action === 'cd') blocks.push({ type: 'info', text: `[cd] ${m.old} → ${m.new}` })
			continue
		}
		if (m.type === 'info') {
			if (m.level === 'error') {
				blocks.push({ type: 'error', text: m.text, detail: m.detail })
			} else {
				blocks.push({ type: 'info', text: m.text })
			}
			continue
		}

		if (m.role === 'user') {
			const text = typeof m.content === 'string' ? m.content : ''
			if (text) blocks.push({ type: 'input', text, model })
		} else if (m.role === 'assistant') {
			if (m.thinkingText) {
				blocks.push({ type: 'thinking', text: m.thinkingText, done: true, model, sessionId, blobId: m.thinkingBlobId })
			}
			if (m.text) {
				blocks.push({ type: 'assistant', text: m.text, done: true, model })
			}
			if (Array.isArray(m.tools)) {
				const assistantTools = m.tools as { id: string; blobId: string; name: string }[]
				const toolBlocks = await mapLimit(assistantTools, replayConfig.blobReadConcurrency, async (tool): Promise<Block> => {
					const resultBlobId = toolResults.get(tool.id)
					const blobId = resultBlobId ?? tool.blobId
					const blobData = await blob.read(sessionId, blobId)
					const callData = blobData?.call ?? {}
					const raw = blobData?.result?.content ?? ''
					const output = typeof raw === 'string' ? raw : raw.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || '[image]'
					const status = blobData?.result?.status === 'error' ? 'error' : (blobData?.result ? 'done' : 'error')
					const now = Date.now()
					return {
						type: 'tool',
						name: tool.name,
						args: typeof callData.input === 'string' ? callData.input : tools.argsPreview({ id: tool.blobId, name: tool.name, input: callData.input }),
						output,
						status,
						startTime: now,
						endTime: now,
						blobId,
						sessionId,
					}
				})
				blocks.push(...toolBlocks)
			}
		}
	}

	if (busy) return blocks

	// Detect unfinished state
	const interrupted = sessionHistory.detectInterruptedTools(messages)
	if (interrupted.length > 0) {
		const toolList = interrupted.map(t => t.name).join(', ')
		blocks.push({ type: 'info', text: `[interrupted] during tools (${toolList}). Press Enter to continue` })
	} else if (messages.length > 0) {
		// Check for pending turn: last role-bearing message is 'user' or 'tool_result' (not a [system] prefix)
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as any
			if (m.role) {
				const text = typeof m.content === 'string' ? m.content : ''
				if ((m.role === 'user' && !text.startsWith('[system]')) || m.role === 'tool_result') {
					blocks.push({ type: 'info', text: '[interrupted] Type /continue to continue' })
				}
				break
			}
		}
	}

	return blocks
}

export const replay = { replayToBlocks }
