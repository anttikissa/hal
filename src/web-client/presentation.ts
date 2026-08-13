import type { HistoryEntry } from '../common/history.ts'
import type { LiveBlock, LiveToolBlock } from '../common/live-event-blocks.ts'

type TranscriptItem = HistoryEntry | LiveBlock

type ToolLike = {
	type?: string
	name?: string
	input?: unknown
	output?: unknown
	running?: boolean
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

function historyItems(history: readonly HistoryEntry[]): TranscriptItem[] {
	const items: TranscriptItem[] = []
	const tools = new Map<string, LiveToolBlock>()
	for (const entry of history) {
		if (entry.type === 'tool_call') {
			const tool: LiveToolBlock = {
				type: 'tool',
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
			if (entry.blobId) tool.blobId = entry.blobId
			if (entry.canceled) tool.canceled = true
			continue
		}
		items.push(entry)
	}
	return items
}

export const webPresentation = { valueText, toolText, historyItems }
