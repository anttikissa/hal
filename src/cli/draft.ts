// Persist the current prompt per session so tab switches and restarts keep it.
// draft_saved lets other clients refresh their in-memory copy.

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { sessions } from '../server/sessions.ts'
import { ipc } from '../ipc.ts'
import { ason } from '../utils/ason.ts'
import { log } from '../utils/log.ts'

interface DraftFile {
	text: string
	savedAt: string
}

function draftPath(sessionId: string): string {
	return `${sessions.sessionDir(sessionId)}/draft.ason`
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

function isMissingFileError(err: unknown): boolean {
	return !!err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT'
}

function logDraftError(action: 'save' | 'load' | 'clear', sessionId: string, err: unknown): void {
	log.error('draft operation failed', { action, sessionId, error: errorMessage(err) })
}

function saveDraft(sessionId: string, text: string): void {
	if (!text) {
		clearDraft(sessionId)
		return
	}
	const data: DraftFile = { text, savedAt: new Date().toISOString() }
	try {
		writeFileSync(draftPath(sessionId), ason.stringify(data) + '\n')
	} catch (err) {
		logDraftError('save', sessionId, err)
		return
	}
	// Only notify other clients after the file is definitely on disk.
	ipc.appendEvent({ type: 'draft_saved', sessionId })
}

function loadDraft(sessionId: string): string {
	const path = draftPath(sessionId)
	if (!existsSync(path)) return ''
	try {
		const data = ason.parse(readFileSync(path, 'utf-8')) as unknown as DraftFile
		return data?.text ?? ''
	} catch (err) {
		logDraftError('load', sessionId, err)
		return ''
	}
}

function clearDraft(sessionId: string): void {
	const path = draftPath(sessionId)
	try {
		if (existsSync(path)) unlinkSync(path)
	} catch (err) {
		// Racy delete-after-exists-check is fine. Other errors mean the draft was
		// not cleared, so do not broadcast a misleading draft_saved event.
		if (!isMissingFileError(err)) {
			logDraftError('clear', sessionId, err)
			return
		}
	}
	ipc.appendEvent({ type: 'draft_saved', sessionId })
}

export const draft = { saveDraft, loadDraft, clearDraft }
