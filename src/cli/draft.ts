import { writeFile, unlink, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename } from 'path'
import { state } from '../state.ts'
import { readFiles } from '../utils/read-file.ts'
import { ipc } from '../ipc.ts'
import { protocol } from '../protocol.ts'

const IMAGE_PATTERN = /\[([^\]]+\.(png|jpg|jpeg|gif|webp))\]/gi

function draftPath(sessionId: string): string {
	return `${state.sessionDir(sessionId)}/draft.txt`
}

/** Copy /tmp/ images to session dir so they survive tmp cleanup. */
async function persistTempImages(sessionId: string, text: string): Promise<string> {
	let result = text
	for (const match of text.matchAll(IMAGE_PATTERN)) {
		const src = match[1]
		if (!src.startsWith('/tmp/') || !existsSync(src)) continue
		const dir = `${state.sessionDir(sessionId)}/images`
		state.ensureDir(dir)
		const dest = `${dir}/${basename(src)}`
		if (!existsSync(dest)) await copyFile(src, dest)
		result = result.replaceAll(match[0], `[${dest}]`)
	}
	return result
}

export async function saveDraft(sessionId: string, text: string): Promise<void> {
	// Empty text: don't touch file (preserve drafts from other clients)
	if (!text) return
	state.ensureDir(state.sessionDir(sessionId))
	const saved = await persistTempImages(sessionId, text)
	await writeFile(draftPath(sessionId), saved)
	void ipc.events.append({ id: protocol.eventId(), type: 'draft_saved', sessionId, createdAt: new Date().toISOString() })
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

async function clearDraft(sessionId: string): Promise<void> {
	const path = draftPath(sessionId)
	if (existsSync(path)) await unlink(path).catch(() => {})
}

export const draft = { saveDraft, loadDraft, clearDraft }
