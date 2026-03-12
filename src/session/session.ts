// Session CRUD — create, load, list, rotate.
// Sessions use liveFile: mutate the object, it auto-saves to session.ason.

import { writeFile, appendFile } from 'fs/promises'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { resolve, join } from 'path'
import { SESSIONS_DIR, EPOCH_PATH, LAUNCH_CWD, state } from '../state.ts'
import { liveFiles } from '../utils/live-file.ts'
import { ason } from '../utils/ason.ts'
import { readFiles } from '../utils/read-file.ts'
import type { SessionInfo } from '../protocol.ts'

export type { SessionInfo }

let _epoch: Date | null = null

async function ensureEpoch(): Promise<Date> {
	if (_epoch) return _epoch
	if (existsSync(EPOCH_PATH)) {
		_epoch = new Date((await readFiles.readText(EPOCH_PATH, 'session.ensureEpoch')).trim())
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
		if (!existsSync(state.sessionDir(id))) return id
	}
	return generateId(epoch, 4)
}

function sessionPath(id: string): string {
	return `${state.sessionDir(id)}/session.ason`
}

const SESSION_DEFAULTS: SessionInfo = {
	id: '',
	workingDir: '',
	createdAt: '',
	updatedAt: '',
}

export function loadSessionInfo(id: string): SessionInfo | null {
	const path = sessionPath(id)
	if (!existsSync(path)) return null
	return liveFiles.liveFile<SessionInfo>(path, { defaults: { ...SESSION_DEFAULTS, id } })
}

export async function createSession(workingDir?: string): Promise<SessionInfo> {
	const id = await makeSessionId()
	state.ensureDir(state.sessionDir(id))
	const ts = new Date().toISOString()
	const info = liveFiles.liveFile<SessionInfo>(sessionPath(id), {
		defaults: {
			id,
			workingDir: resolve(workingDir ?? LAUNCH_CWD),
			log: 'history.asonl',
			createdAt: ts,
			updatedAt: ts,
		},
	})
	info.updatedAt = ts
	;(info as SessionInfo & { save?: () => void }).save?.()
	return info
}

export async function listSessionIds(): Promise<string[]> {
	if (!existsSync(SESSIONS_DIR)) return []
	const entries = await (await import('fs/promises')).readdir(SESSIONS_DIR)
	return entries.filter(e => existsSync(sessionPath(e))).sort()
}

export async function forkSession(sourceId: string): Promise<string> {
	const id = await makeSessionId()
	const dir = state.sessionDir(id)
	state.ensureDir(dir)
	const ts = new Date().toISOString()
	const sourceMeta = loadSessionInfo(sourceId)
	const meta = liveFiles.liveFile<SessionInfo>(sessionPath(id), {
		defaults: { id, workingDir: resolve(LAUNCH_CWD), log: 'history.asonl', createdAt: ts, updatedAt: ts },
	})
	if (sourceMeta?.model) meta.model = sourceMeta.model
	meta.updatedAt = ts
	;(meta as SessionInfo & { save?: () => void }).save?.()
	await appendFile(join(dir, 'history.asonl'), ason.stringify({ type: 'forked_from', parent: sourceId, ts }) + '\n')
	return id
}

export function currentLog(sessionId: string): string {
	const meta = loadSessionInfo(sessionId)
	return meta?.log ?? 'history.asonl'
}

export async function rotateLog(sessionId: string): Promise<string> {
	const cur = currentLog(sessionId)
	let nextN = 2
	if (cur !== 'history.asonl') {
		const match = cur.match(/^history(\d+)\.asonl$/)
		if (match) nextN = parseInt(match[1], 10) + 1
	}
	const newLog = `history${nextN}.asonl`
	const meta = loadSessionInfo(sessionId)
	if (meta) {
		meta.log = newLog
		;(meta as SessionInfo & { save?: () => void }).save?.()
	}
	logNameCache.delete(sessionId)
	return newLog
}

export const logNameCache = new Map<string, string>()

export const session = {
	makeSessionId,
	loadSessionInfo,
	createSession,
	listSessionIds,
	forkSession,
	currentLog,
	rotateLog,
	logNameCache,
}
