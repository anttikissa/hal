// Session CRUD — create, load, list, persist.
// SessionInfo is the canonical type; meta.ason is the disk format.

import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { resolve } from 'path'
import { stringify, parse } from '../utils/ason.ts'
import { SESSIONS_DIR, EPOCH_PATH, LAUNCH_CWD, ensureDir, sessionDir } from '../state.ts'
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

// ── Meta persistence ──

function metaPath(id: string): string {
	return `${sessionDir(id)}/meta.ason`
}

export async function saveMeta(info: SessionInfo): Promise<void> {
	const dir = sessionDir(info.id)
	ensureDir(dir)
	info.updatedAt = new Date().toISOString()
	const tmp = `${metaPath(info.id)}.tmp.${process.pid}`
	await writeFile(tmp, stringify(info) + '\n')
	await rename(tmp, metaPath(info.id))
}

export async function loadMeta(id: string): Promise<SessionInfo | null> {
	const path = metaPath(id)
	if (!existsSync(path)) return null
	try {
		return parse(await readFile(path, 'utf-8')) as SessionInfo
	} catch {
		return null
	}
}

// ── Create ──

export async function createSession(workingDir?: string): Promise<SessionInfo> {
	const id = await makeSessionId()
	const ts = new Date().toISOString()
	const info: SessionInfo = {
		id,
		workingDir: resolve(workingDir ?? LAUNCH_CWD),
		createdAt: ts,
		updatedAt: ts,
	}
	await saveMeta(info)
	return info
}

// ── List (scan directories) ──

export async function listSessionIds(): Promise<string[]> {
	if (!existsSync(SESSIONS_DIR)) return []
	const entries = await (await import('fs/promises')).readdir(SESSIONS_DIR)
	return entries.filter(e => existsSync(metaPath(e))).sort()
}
