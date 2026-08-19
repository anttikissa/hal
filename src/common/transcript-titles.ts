import type { HistoryEntry } from './history.ts'
import type { LiveBlock } from './live-event-blocks.ts'
import { models } from './models.ts'

type TranscriptItem = HistoryEntry | LiveBlock

function formatTime(ts: string | number | undefined): string {
	if (ts === undefined) return ''
	const date = new Date(ts)
	if (Number.isNaN(date.getTime())) return ''
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function humanize(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ')
}

function title(item: TranscriptItem): string {
	if (item.type === 'user') return 'You'
	if (item.type === 'assistant') {
		if (item.synthetic) return 'Hal (synthetic)'
		const model = models.displayModel(item.model)
		return model ? `Hal (${model})` : 'Hal'
	}
	if (item.type === 'thinking') {
		const model = models.displayModel(item.model)
		const effort = item.thinkingEffort ?? models.reasoningEffort(item.model)
		if (model && effort) return `Hal (${model}, thinking ${effort})`
		if (model) return `Hal (${model}, thinking)`
		return 'Thinking'
	}
	if (item.type === 'tool') return humanize(item.name)
	if (item.type === 'tool_call') return humanize(item.name)
	if (item.type === 'tool_result') return 'Tool result'
	if (item.type === 'log') return item.text.startsWith('Prompt queued') ? item.text.split('\n', 1)[0]! : ''
	if (item.type === 'info' || item.type === 'cwd' || item.type === 'model') return ''
	if (item.type === 'warning') return 'Warning'
	if (item.type === 'error') return 'Error'
	if (item.type === 'fork' || item.type === 'forked_from' || item.type === 'forked_to') return 'Fork'
	return 'Hal'
}

function label(item: TranscriptItem): string {
	const time = formatTime(item.ts)
	return `${time} ${title(item)}`.trim()
}

export const transcriptTitles = { formatTime, title, label }
