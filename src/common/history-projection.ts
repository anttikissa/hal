import type { HistoryEntry } from './history.ts'

export type UserTextOptions = {
	separator?: string
	images?: 'omit' | 'path-or-image' | 'path-or-blob-or-image'
	display?: 'actual' | 'ui'
}

function userText(entry: Extract<HistoryEntry, { type: 'user' }>, opts: UserTextOptions | string = {}): string {
	const options = typeof opts === 'string' ? { separator: opts } : opts
	const separator = options.separator ?? ''
	const images = options.images ?? 'omit'
	const parts: string[] = []
	for (const part of entry.parts) {
		if (part.type === 'text') {
			const text = options.display === 'ui' ? part.displayText ?? part.text : part.text
			if (text) parts.push(text)
			continue
		}
		if (images === 'path-or-image') {
			parts.push(part.originalFile ? `[${part.originalFile}]` : '[image]')
			continue
		}
		if (images === 'path-or-blob-or-image') {
			const ref = part.originalFile ?? part.blobId
			parts.push(ref ? `[${ref}]` : '[image]')
		}
	}
	return parts.join(separator)
}

function noticeText(text: string): string {
	const marker = text.match(/^\[([A-Za-z][^\]\n]*)\]$/)
	if (!marker) return text
	return marker[1]![0]!.toUpperCase() + marker[1]!.slice(1)
}

function inputHistoryFromEntries(entries: HistoryEntry[]): string[] {
	const history: string[] = []
	for (const entry of entries) {
		let text = ''
		if (entry.type === 'input_history') text = entry.text
		// Inbox and subagent handoffs are persisted as user entries, but were not
		// typed by the local user and must stay out of up-arrow editing history.
		if (entry.type === 'user' && !entry.source) {
			text = historyProjection.userText(entry, { images: 'path-or-blob-or-image', display: 'ui' })
		}
		if (text && !text.startsWith('[system]')) history.push(text)
	}
	return history.slice(-200)
}

export const historyProjection = { userText, noticeText, inputHistoryFromEntries }
