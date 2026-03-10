// Replay — convert messages to Block[] for TUI history display.

import type { Block } from '../cli/blocks.ts'
import type { Message } from './messages.ts'
import { readBlock } from './messages.ts'
import { argsPreview } from '../runtime/tools.ts'
/** Convert a message log to display blocks (for tab history). */
export async function replayToBlocks(sessionId: string, messages: Message[], model?: string): Promise<Block[]> {
	const blocks: Block[] = []

	// Collect tool_result entries for matching
	const toolResults = new Map<string, string>()
	for (const msg of messages) {
		const m = msg as any
		if (m.role === 'tool_result') toolResults.set(m.tool_use_id, m.ref)
	}

	for (const msg of messages) {
		const m = msg as any
		if (m.type === 'reset' || m.type === 'forked_from' || m.type === 'handoff') continue
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
				blocks.push({ type: 'thinking', text: m.thinkingText, done: true, model, sessionId, ref: m.thinkingRef })
			}
			if (m.text) {
				blocks.push({ type: 'assistant', text: m.text, done: true, model })
			}
			if (Array.isArray(m.tools)) {
				for (const tool of m.tools) {
					const resultRef = toolResults.get(tool.id)
					const block = resultRef ? await readBlock(sessionId, resultRef) : await readBlock(sessionId, tool.ref)
					const callData = block?.call ?? {}
					const raw = block?.result?.content ?? ''
					const output = typeof raw === 'string' ? raw : raw.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || '[image]'
					const status = block?.result?.status === 'error' ? 'error' : (block?.result ? 'done' : 'error')
					const now = Date.now()
					blocks.push({
						type: 'tool',
						name: tool.name,
						args: typeof callData.input === 'string' ? callData.input : argsPreview({ id: tool.ref, name: tool.name, input: callData.input }),
						output,
						status,
						startTime: now, endTime: now,
						ref: resultRef ?? tool.ref,
						sessionId,
					})
				}
			}
		}
	}

	return blocks
}