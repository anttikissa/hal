// Session CRUD — create, load, list, rotate.
// Sessions use liveFile: mutate the object, it auto-saves to meta.ason.

import { readFile, writeFile, appendFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { resolve, join } from 'path'
import { SESSIONS_DIR, EPOCH_PATH, LAUNCH_CWD, ensureDir, sessionDir } from '../state.ts'
import { liveFile } from '../utils/live-file.ts'
import { stringify } from '../utils/ason.ts'
import type { SessionInfo } from '../protocol.ts'

export type { SessionInfo }

// ── Epoch (for DD-xxx session IDs) ──

let _epoch: Date | null = null

async function ensureEpoch(): Promise<Date> {
	if (_epoch) return _epoch
	if (existsSync(EPOCH_PATH)) {
		_epoch = new Date((await readFile(EPOCH_PATH, 'utf-8')).trim())
	} else {
		_epoch = new Date()
		await writeFile(EPOCH_PATH, _epoch.toISOString() + '\n')
	}
	return _epoch
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

function generateId(epoch: Date, suffixLen: number): string {
	const dd = String(Math.max(0, Math.floor((Date.now() - epoch.getTime()) / 86_400_000))).padStart(2, '0')
	const bytes = randomBytes(suffixLen)
	let suffix = ''
	for (let i = 0; i < suffixLen; i++) suffix += ID_CHARS[bytes[i] % ID_CHARS.length]
	return `${dd}-${suffix}`
}

export async function makeSessionId(): Promise<string> {
	const epoch = await ensureEpoch()
	for (let i = 0; i < 10; i++) {
		const id = generateId(epoch, 3)
		if (!existsSync(sessionDir(id))) return id
	}
	return generateId(epoch, 4)
}

// ── Meta (liveFile-backed) ──

function metaPath(id: string): string {
	return `${sessionDir(id)}/meta.ason`
}

const META_DEFAULTS: SessionInfo = {
	id: '', workingDir: '', createdAt: '', updatedAt: '',
}

/** Load a session's meta as a live proxy. Mutations auto-save to disk. */
export function loadMeta(id: string): SessionInfo | null {
	const path = metaPath(id)
	if (!existsSync(path)) return null
	return liveFile<SessionInfo>(path, { defaults: { ...META_DEFAULTS, id } })
}

/** Create a new session. Returns a live proxy — mutate it, it saves. */
export async function createSession(workingDir?: string): Promise<SessionInfo> {
	const id = await makeSessionId()
	ensureDir(sessionDir(id))
	const ts = new Date().toISOString()
	const info = liveFile<SessionInfo>(metaPath(id), {
		defaults: {
			id,
			workingDir: resolve(workingDir ?? LAUNCH_CWD),
			log: 'messages.asonl',
			createdAt: ts,
			updatedAt: ts,
		},
	})
	// Force initial save
	info.updatedAt = ts
	;(info as SessionInfo & { save?: () => void }).save?.()
	return info
}

// ── List ──

export async function listSessionIds(): Promise<string[]> {
	if (!existsSync(SESSIONS_DIR)) return []
	const entries = await (await import('fs/promises')).readdir(SESSIONS_DIR)
	return entries.filter(e => existsSync(metaPath(e))).sort()
}

// ── Fork ──

/** Fork a session. Creates a new session with a forked_from pointer. */
export async function forkSession(sourceId: string): Promise<string> {
	const id = await makeSessionId()
	const dir = sessionDir(id)
	ensureDir(dir)
	const ts = new Date().toISOString()
	const meta = liveFile<SessionInfo>(metaPath(id), {
		defaults: { id, workingDir: resolve(LAUNCH_CWD), log: 'messages.asonl', createdAt: ts, updatedAt: ts },
	})
	meta.updatedAt = ts
	;(meta as SessionInfo & { save?: () => void }).save?.()
	await appendFile(join(dir, 'messages.asonl'), stringify({ type: 'forked_from', parent: sourceId, ts }) + '\n')
	return id
}

// ── Log rotation ──

/** Read the current log filename for a session from meta.ason. */
export function currentLog(sessionId: string): string {
	const meta = loadMeta(sessionId)
	return meta?.log ?? 'messages.asonl'
}

/** Rotate: bump to next log file. Returns the new filename. */
export async function rotateLog(sessionId: string): Promise<string> {
	const cur = currentLog(sessionId)
	let nextN = 2
	if (cur !== 'messages.asonl') {
		const match = cur.match(/^messages(\d+)\.asonl$/)
		if (match) nextN = parseInt(match[1], 10) + 1
	}

	const newLog = `messages${nextN}.asonl`
	const meta = loadMeta(sessionId)
	if (meta) {
		meta.log = newLog
		;(meta as SessionInfo & { save?: () => void }).save?.()
	}
	// Invalidate messagesLog cache
	logNameCache.delete(sessionId)
	return newLog
}

// Cache for messagesLog — invalidated by rotateLog
export const logNameCache = new Map<string, string>()