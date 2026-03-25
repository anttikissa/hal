// Draft persistence — saves the user's in-progress prompt text to disk
// so it survives tab switches, restarts, and multi-client scenarios.
//
// Each session gets a draft.ason in its session directory. When a draft
// is saved, a draft_saved event is emitted via IPC so other clients can
// pick it up (e.g. client A quits with a draft on tab 10, client B
// sees it appear on tab 10 even if client B isn't looking at that tab).

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { sessions } from '../server/sessions.ts'
import { ipc } from '../ipc.ts'
import { ason } from '../utils/ason.ts'

interface DraftFile {
	text: string
	savedAt: string
}

function draftPath(sessionId: string): string {
	return `${sessions.sessionDir(sessionId)}/draft.ason`
}

// Save draft to disk and notify other clients via IPC event.
function saveDraft(sessionId: string, text: string): void {
	if (!text) { clearDraft(sessionId); return }
	const data: DraftFile = { text, savedAt: new Date().toISOString() }
	try {
		writeFileSync(draftPath(sessionId), ason.stringify(data) + '\n')
	} catch {}
	// Notify other clients so they can pick up the draft
	ipc.appendEvent({ type: 'draft_saved', sessionId })
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
	// Notify so other clients clear their in-memory copy too
	ipc.appendEvent({ type: 'draft_saved', sessionId })
}

export const draft = { saveDraft, loadDraft, clearDraft }
