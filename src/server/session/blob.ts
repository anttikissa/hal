// Store large history payloads in per-session blob files instead of inline ASONL.

import { writeFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { ensureDir } from '../state.ts'
import { sessions } from '../sessions.ts'
import { ason } from '../../utils/ason.ts'

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const state = { starts: new Map<string, number>(), forkParents: new Map<string, string | null>() }

function sessionStart(sessionId: string): number {
	let ts = state.starts.get(sessionId)
	if (ts !== undefined) return ts
	const meta = sessions.loadSessionMeta(sessionId)
	ts = meta ? new Date(meta.createdAt).getTime() : Date.now()
	state.starts.set(sessionId, ts)
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
	ensureDir(dir)
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

// Forks share history but do not copy blobs, so walk back to the parent on demand.
// The parent never changes, so cache it: resolving it per blob re-parsed the entire
// history file, which cost seconds once a session had hundreds of tool results.
function forkParent(sessionId: string): string | null {
	let parent = state.forkParents.get(sessionId)
	if (parent !== undefined) return parent
	const first = sessions.loadHistory(sessionId)[0]
	parent = first?.type === 'forked_from' ? (first.parent ?? null) : null
	state.forkParents.set(sessionId, parent)
	return parent
}

function readBlobFromChain(sessionId: string, blobId: string): any | null {
	const local = readBlob(sessionId, blobId)
	if (local) return local
	const parent = forkParent(sessionId)
	return parent ? readBlobFromChain(parent, blobId) : null
}

export const blob = {
	state,
	makeBlobId,
	writeBlob,
	readBlob,
	readBlobFromChain,
	blobsDir,
}
