import { writeFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { state } from '../state.ts'
import { readFiles } from '../utils/read-file.ts'

function queuePath(sessionId: string): string {
	return `${state.sessionDir(sessionId)}/queue.txt`
}

async function saveQueue(sessionId: string, text: string): Promise<void> {
	if (!text) {
		const path = queuePath(sessionId)
		if (existsSync(path)) await unlink(path).catch(() => {})
		return
	}
	state.ensureDir(state.sessionDir(sessionId))
	await writeFile(queuePath(sessionId), text)
}

async function loadQueue(sessionId: string): Promise<string> {
	const path = queuePath(sessionId)
	if (!existsSync(path)) return ''
	try {
		return await readFiles.readText(path, 'queue.loadQueue')
	} catch {
		return ''
	}
}

export const queue = { saveQueue, loadQueue }
