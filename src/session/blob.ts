// Store large history payloads in per-session blob files instead of inline ASONL.

import { writeFile } from 'fs/promises'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { sessions } from '../server/sessions.ts'
import { ason } from '../utils/ason.ts'

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const startCache = new Map<string, number>()

function sessionStart(sessionId: string): number {
	let ts = startCache.get(sessionId)
	if (ts !== undefined) return ts
	const meta = sessions.loadSessionMeta(sessionId)
	ts = meta ? new Date(meta.createdAt).getTime() : Date.now()
	startCache.set(sessionId, ts)
	return ts
}

function makeBlobId(sessionId: string): string {
	const offset = Math.max(0, Date.now() - sessionStart(sessionId))
		.toString(36)
		.padStart(6, '0')
	const bytes = randomBytes(3)
	let suffix = ''
	for (let i = 0; i < 3; i++) suffix += ID_CHARS[bytes[i]! % ID_CHARS.length]
	return `${offset}-${suffix}`
}

function blobsDir(sessionId: string): string {
	return `${sessions.sessionDir(sessionId)}/blobs`
}

async function writeBlob(sessionId: string, blobId: string, data: unknown): Promise<void> {
	const dir = blobsDir(sessionId)
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
	await writeFile(`${dir}/${blobId}.ason`, ason.stringify(data) + '\n')
}

function readBlob(sessionId: string, blobId: string): any | null {
	const path = `${blobsDir(sessionId)}/${blobId}.ason`
	if (!existsSync(path)) return null
	try {
		return ason.parse(readFileSync(path, 'utf-8'))
	} catch {
		return null
	}
}

function readBlobFromChain(sessionId: string, blobId: string): any | null {
	const local = readBlob(sessionId, blobId)
	if (local) return local

	// Forks share history but do not copy blobs, so walk back to the parent on demand.
	const history = sessions.loadHistory(sessionId)
	if (history.length > 0 && history[0]?.type === 'forked_from' && history[0].parent) {
		return readBlobFromChain(history[0].parent, blobId)
	}
	return null
}

export const blob = {
	makeBlobId,
	writeBlob,
	readBlob,
	readBlobFromChain,
	blobsDir,
}
