// Replay — convert messages to Block[] for TUI history display.

import type { Block } from '../cli/blocks.ts'
import type { Message } from './messages.ts'

/** Convert a message log to display blocks (for tab history). */
export function replayToBlocks(messages: Message[], model?: string): Block[] {
	const blocks: Block[] = []

	for (const msg of messages) {
		const m = msg as any
		if (m.type === 'reset' || m.type === 'forked_from' || m.type === 'handoff') continue

		if (m.role === 'user') {
			const text = typeof m.content === 'string' ? m.content : ''
			if (text) blocks.push({ type: 'input', text, model })
		} else if (m.role === 'assistant') {
			if (m.thinkingText) {
				blocks.push({ type: 'thinking', text: m.thinkingText, done: true })
			}
			if (m.text) {
				blocks.push({ type: 'assistant', text: m.text, done: true, model })
			}
			if (Array.isArray(m.tools)) {
				for (const tool of m.tools) {
					const now = Date.now()
					blocks.push({
						type: 'tool',
						name: tool.name,
						args: typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input ?? {}),
						output: tool.result ?? '',
						status: 'done',
						startTime: now, endTime: now,
					})
				}
			}
		}
	}

	return blocks
}
