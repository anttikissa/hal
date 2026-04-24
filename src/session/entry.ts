import type { HistoryEntry } from '../server/sessions.ts'
import { blob } from './blob.ts'

/**
 * Small helpers for working with stored history entries. Replay, block rendering,
 * and API message rebuilding all need the same user-text and blob-loading rules,
 * so keep them here instead of carrying slightly different copies.
 */

type UserTextOptions = {
	separator?: string
	images?: 'omit' | 'path-or-image' | 'path-or-blob-or-image'
	display?: 'actual' | 'ui'
}

function userText(entry: Extract<HistoryEntry, { type: 'user' }>, opts: UserTextOptions | string = {}): string {
	const options = typeof opts === 'string' ? { separator: opts } : opts
	const separator = options.separator ?? ''
	const images = options.images ?? 'omit'
	return entry.parts
		.map((part) => {
			if (part.type === 'text') return options.display === 'ui' ? part.displayText ?? part.text : part.text
			if (images === 'path-or-image') return part.originalFile ? `[${part.originalFile}]` : '[image]'
			if (images === 'path-or-blob-or-image') {
				const ref = part.originalFile ?? part.blobId
				return ref ? `[${ref}]` : '[image]'
			}
			return ''
		})
		.filter(Boolean)
		.join(separator)
}

function loadEntryBlob(sessionId: string, entry: { blobId?: string }): any | null {
	if (!entry.blobId) return null
	return blob.readBlobFromChain(sessionId, entry.blobId)
}

export const sessionEntry = { userText, loadEntryBlob }
