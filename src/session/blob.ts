// Session blob store — content-addressed .ason files under sessions/<id>/blobs/.

import { writeFile, readFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { state } from '../state.ts'
import { ason } from '../utils/ason.ts'
import { historyFork } from './history-fork.ts'

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

const sessionStartCache = new Map<string, number>()

function sessionStart(sessionId: string): number {
	let ts = sessionStartCache.get(sessionId)
	if (ts !== undefined) return ts
	try {
		const meta = ason.parse(readFileSync(`${state.sessionDir(sessionId)}/session.ason`, 'utf-8')) as any
		ts = new Date(meta.createdAt).getTime()
	} catch {
		ts = Date.now()
	}
	sessionStartCache.set(sessionId, ts)
	return ts
}

export function makeBlobId(sessionId: string): string {
	const offset = Math.max(0, Date.now() - sessionStart(sessionId)).toString(36).padStart(6, '0')
	const bytes = randomBytes(3)
	let suffix = ''
	for (let i = 0; i < 3; i++) suffix += ID_CHARS[bytes[i] % ID_CHARS.length]
	return `${offset}-${suffix}`
}

export async function writeBlob(sessionId: string, blobId: string, data: unknown): Promise<void> {
	const dir = state.blobsDir(sessionId)
	state.ensureDir(dir)
	await writeFile(`${dir}/${blobId}.ason`, ason.stringify(data) + '\n')
}

async function readLocalBlob(sessionId: string, blobId: string): Promise<any | null> {
	const path = `${state.blobsDir(sessionId)}/${blobId}.ason`
	if (!existsSync(path)) return null
	try {
		return ason.parse(await readFile(path, 'utf-8'))
	} catch {
		return null
	}
}

export async function readBlob(sessionId: string, blobId: string): Promise<any | null> {
	return historyFork.readBlobFromForkChain(sessionId, blobId, readLocalBlob)
}

export const blob = {
	makeBlobId,
	writeBlob,
	readBlob,
}
