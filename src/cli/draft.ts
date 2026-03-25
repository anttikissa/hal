// Draft persistence — saves the user's in-progress prompt text to disk
// so it survives tab switches, restarts, and multi-client scenarios.
// Each session gets a draft.ason in its session directory.

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { sessions } from '../server/sessions.ts'
import { ason } from '../utils/ason.ts'

interface DraftFile {
	text: string
	savedAt: string
}

function draftPath(sessionId: string): string {
	return `${sessions.sessionDir(sessionId)}/draft.ason`
}

function saveDraft(sessionId: string, text: string): void {
	if (!text) { clearDraft(sessionId); return }
	const data: DraftFile = { text, savedAt: new Date().toISOString() }
	try {
		writeFileSync(draftPath(sessionId), ason.stringify(data) + '\n')
	} catch {}
}

function loadDraft(sessionId: string): string {
	const path = draftPath(sessionId)
	if (!existsSync(path)) return ''
	try {
		const data = ason.parse(readFileSync(path, 'utf-8')) as unknown as DraftFile
		return data?.text ?? ''
	} catch {
		return ''
	}
}

function clearDraft(sessionId: string): void {
	const path = draftPath(sessionId)
	try { if (existsSync(path)) unlinkSync(path) } catch {}
}

export const draft = { saveDraft, loadDraft, clearDraft }
