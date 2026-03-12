// Session blob store — content-addressed .ason files under sessions/<id>/blobs/.

import { writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { state } from '../state.ts'
import { ason } from '../utils/ason.ts'
import { historyFork } from './history-fork.ts'
import { readFiles } from '../utils/read-file.ts'

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

const sessionStartCache = new Map<string, number>()

function sessionStart(sessionId: string): number {
	let ts = sessionStartCache.get(sessionId)
	if (ts !== undefined) return ts
	try {
		const meta = ason.parse(readFiles.readTextSync(`${state.sessionDir(sessionId)}/session.ason`, 'blob.sessionStart')) as any
		ts = new Date(meta.createdAt).getTime()
	} catch {
		ts = Date.now()
	}
	sessionStartCache.set(sessionId, ts)
	return ts
}

function makeId(sessionId: string): string {
	const offset = Math.max(0, Date.now() - sessionStart(sessionId)).toString(36).padStart(6, '0')
	const bytes = randomBytes(3)
	let suffix = ''
	for (let i = 0; i < 3; i++) suffix += ID_CHARS[bytes[i] % ID_CHARS.length]
	return `${offset}-${suffix}`
}

async function write(sessionId: string, blobId: string, data: unknown): Promise<void> {
	const dir = state.blobsDir(sessionId)
	state.ensureDir(dir)
	await writeFile(`${dir}/${blobId}.ason`, ason.stringify(data) + '\n')
}

async function readLocal(sessionId: string, blobId: string): Promise<any | null> {
	const path = `${state.blobsDir(sessionId)}/${blobId}.ason`
	if (!existsSync(path)) return null
	try {
		return ason.parse(await readFiles.readText(path, 'blob.readLocal'))
	} catch {
		return null
	}
}

async function read(sessionId: string, blobId: string): Promise<any | null> {
	return historyFork.readBlobFromForkChain(sessionId, blobId, readLocal)
}

async function updateInput(sessionId: string, blobId: string, input: unknown, originalInput: unknown): Promise<void> {
	const data = await read(sessionId, blobId)
	if (!data?.call) return
	data.call.originalInput = originalInput
	data.call.input = input
	await write(sessionId, blobId, data)
}

export const blob = {
	makeId,
	write,
	read,
	updateInput,
}
