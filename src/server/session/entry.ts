import type { HistoryEntry } from '../sessions.ts'
import { historyProjection, type UserTextOptions } from '../../common/history-projection.ts'
import { blob } from './blob.ts'

/**
 * Small helpers for working with stored history entries. Replay, block rendering,
 * and API message rebuilding all need the same user-text and blob-loading rules,
 * so keep them here instead of carrying slightly different copies.
 */

function userText(entry: Extract<HistoryEntry, { type: 'user' }>, opts: UserTextOptions | string = {}): string {
	return historyProjection.userText(entry, opts)
}

function loadEntryBlob(sessionId: string, entry: { blobId?: string }): any | null {
	if (!entry.blobId) return null
	return blob.readBlobFromChain(sessionId, entry.blobId)
}

export const sessionEntry = { userText, loadEntryBlob }
