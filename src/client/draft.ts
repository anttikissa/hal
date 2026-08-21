// Persist the current prompt per session so tab switches and restarts keep it.
// draft_saved lets other clients refresh their in-memory copy.

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { clientBackend } from './backend.ts'
import { clientTransport } from './transport.ts'
import { ason } from '../utils/ason.ts'
import { log } from '../utils/log.ts'

export type DraftPromptEdit = {
	mode: 'amend' | 'cancel' | 'copy' | 'side-effect-copy'
	originalText: string
	pausedWorkingTurn: boolean
}

interface DraftFile {
	text: string
	savedAt: string
	promptEdit?: DraftPromptEdit
}

const state = { enabled: true }

function draftPath(sessionId: string): string {
	return `${clientBackend.sessions.sessionDir(sessionId)}/draft.ason`
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

function saveDraft(sessionId: string, text: string, promptEdit?: DraftPromptEdit): void {
	if (!state.enabled) return
	if (!text && !promptEdit) {
		clearDraft(sessionId)
		return
	}
	const data: DraftFile = { text, savedAt: new Date().toISOString() }
	if (promptEdit) data.promptEdit = promptEdit
	try {
		writeFileSync(draftPath(sessionId), ason.stringify(data) + '\n')
	} catch (err) {
		logDraftError('save', sessionId, err)
		return
	}
	// Only notify other clients after the file is definitely on disk.
	clientTransport.io.notifyDraftSaved(sessionId)
}

function emptyDraftFile(): DraftFile {
	return { text: '', savedAt: '' }
}

function loadDraftState(sessionId: string): DraftFile {
	if (!state.enabled) return emptyDraftFile()
	const path = draftPath(sessionId)
	if (!existsSync(path)) return emptyDraftFile()
	try {
		const data = ason.parse(readFileSync(path, 'utf-8')) as unknown as DraftFile
		return {
			text: data?.text ?? '',
			savedAt: data?.savedAt ?? '',
			promptEdit: data?.promptEdit,
		}
	} catch (err) {
		logDraftError('load', sessionId, err)
		return emptyDraftFile()
	}
}

function loadDraft(sessionId: string): string {
	return loadDraftState(sessionId).text
}

function clearDraft(sessionId: string): void {
	if (!state.enabled) return
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
	clientTransport.io.notifyDraftSaved(sessionId)
}

export const draft = { state, saveDraft, loadDraft, loadDraftState, clearDraft }
