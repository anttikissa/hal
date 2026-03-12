import { writeFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { state } from '../state.ts'
import { readFiles } from '../utils/read-file.ts'

function draftPath(sessionId: string): string {
	return `${state.sessionDir(sessionId)}/draft.txt`
}

export async function saveDraft(sessionId: string, text: string): Promise<void> {
	if (!text) {
		const path = draftPath(sessionId)
		if (existsSync(path)) await unlink(path).catch(() => {})
		return
	}
	state.ensureDir(state.sessionDir(sessionId))
	await writeFile(draftPath(sessionId), text)
}

export async function loadDraft(sessionId: string): Promise<string> {
	const path = draftPath(sessionId)
	if (!existsSync(path)) return ''
	try {
		return await readFiles.readText(path, 'draft.loadDraft')
	} catch {
		return ''
	}
}

export const draft = { saveDraft, loadDraft }
