import type { HistoryEntry, UserPart } from '../server/sessions.ts'
import { blob } from './blob.ts'

/**
 * Small helpers for working with stored history entries. Replay and API message
 * rebuilding both need the same "just the user text" and "load the entry blob"
 * operations, so keep them here instead of re-implementing the same filters.
 */

function textParts(parts: UserPart[]): Extract<UserPart, { type: 'text' }>[] {
	return parts.filter((part): part is Extract<UserPart, { type: 'text' }> => part.type === 'text')
}

function userText(entry: Extract<HistoryEntry, { type: 'user' }>, separator = ''): string {
	return textParts(entry.parts).map((part) => part.text).join(separator)
}

function loadEntryBlob(sessionId: string, entry: { blobId?: string }): any | null {
	if (!entry.blobId) return null
	return blob.readBlobFromChain(sessionId, entry.blobId)
}

export const sessionEntry = { textParts, userText, loadEntryBlob }
