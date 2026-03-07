// Session CRUD — create, load, list.
// Sessions use liveFile: mutate the object, it auto-saves to meta.ason.

import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { resolve } from 'path'
import { SESSIONS_DIR, EPOCH_PATH, LAUNCH_CWD, ensureDir, sessionDir } from '../state.ts'
import { liveFile } from '../live-file.ts'
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
