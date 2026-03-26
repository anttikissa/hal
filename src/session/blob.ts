// Blob storage — large tool outputs and thinking text stored separately from history.
//
// Blobs live in state/sessions/{id}/blobs/{blobId}.ason. They're referenced by
// blobId from history entries, keeping the ASONL history file small. The blobId
// encodes a time offset from session start + random suffix for uniqueness.

import { writeFile } from 'fs/promises'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { sessions } from '../server/sessions.ts'
import { ason } from '../utils/ason.ts'

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

// Cache session start times to avoid re-reading session.ason for every blob ID
const startCache = new Map<string, number>()

function sessionStart(sessionId: string): number {
	let ts = startCache.get(sessionId)
	if (ts !== undefined) return ts
	const meta = sessions.loadSessionMeta(sessionId)
	ts = meta ? new Date(meta.createdAt).getTime() : Date.now()
	startCache.set(sessionId, ts)
	return ts
}

// Generate a unique blob ID. Format: {timeOffset}-{random3chars}
// Time offset is base36-encoded ms since session creation, so blobs sort chronologically.
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

// Write blob data (any serializable value) to disk.
async function writeBlob(sessionId: string, blobId: string, data: unknown): Promise<void> {
	const dir = blobsDir(sessionId)
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
	await writeFile(`${dir}/${blobId}.ason`, ason.stringify(data) + '\n')
}

// Read a blob by ID. Returns null if the blob doesn't exist or can't be parsed.
function readBlob(sessionId: string, blobId: string): any | null {
	const path = `${blobsDir(sessionId)}/${blobId}.ason`
	if (!existsSync(path)) return null
	try {
		return ason.parse(readFileSync(path, 'utf-8'))
	} catch {
		return null
	}
}

// Read a blob, following fork chains if not found locally.
// When a session is forked, blobs from the parent are not copied — we traverse
// the fork chain to find them.
function readBlobFromChain(sessionId: string, blobId: string): any | null {
	const local = readBlob(sessionId, blobId)
	if (local) return local

	// Check if this session was forked, and look in parent
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
