// Sessions: one directory per session under sessions/, with its metadata
// in session.ason. Open sessions hold that file as a liveFile, so edits
// to the returned object persist. The host may keep several open at once.
// A session needs no history to be valid. Malformed metadata is reported
// and left on disk untouched; it is never replaced with defaults.

import { existsSync, mkdirSync, readdirSync } from 'fs'
import type { SessionMeta } from '../common/session.ts'
import { liveFiles } from './live-file.ts'
import { models } from './models.ts'
import { paths } from './paths.ts'

export type { SessionMeta } from '../common/session.ts'

export type SessionListing = { id: string; meta?: SessionMeta; error?: string }

function metaPath(id: string): string {
	return `${paths.sessionDir(id)}/session.ason`
}

// Throws unless data has the required fields and matches its directory.
function validate(id: string, data: Record<string, any>): void {
	let path = metaPath(id)
	if (data.id !== id) throw new Error(`${path}: id ${JSON.stringify(data.id)} does not match directory`)
	for (let key of ['cwd', 'model', 'createdAt']) {
		if (typeof data[key] !== 'string') throw new Error(`${path}: missing or invalid ${key}`)
	}
	if (data.name !== undefined && typeof data.name !== 'string') throw new Error(`${path}: invalid name`)
}

// Loads and validates metadata as a liveFile. Throws if missing/invalid.
function load(id: string, watch: boolean): SessionMeta {
	let path = metaPath(id)
	if (!existsSync(path)) throw new Error(`${path}: no such session`)
	let data = liveFiles.liveFile<Record<string, any>>(path, {}, { watch })
	try {
		sessions.validate(id, data)
	} catch (e) {
		liveFiles.close(data)
		throw e
	}
	return data as SessionMeta
}

// "<n>-<abc>": n one past the highest in use, then three random letters.
// The directory is claimed with a non-recursive mkdir, so two creators
// never share one.
function claimId(): string {
	mkdirSync(paths.sessionsDir(), { recursive: true })
	let top = 0
	for (let name of readdirSync(paths.sessionsDir())) top = Math.max(top, parseInt(name) || 0)
	for (let n = top + 1; ; n++) {
		let letters = Array.from({ length: 3 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')
		let id = `${n}-${letters}`
		try {
			mkdirSync(paths.sessionDir(id))
			return id
		} catch (e: any) {
			if (e?.code !== 'EEXIST') throw e
		}
	}
}

function create(init: { cwd: string; model?: string; name?: string }): SessionMeta {
	let id = sessions.claimId()
	let meta: SessionMeta = {
		id,
		cwd: init.cwd,
		model: init.model ?? models.defaultModel(),
		createdAt: new Date().toISOString(),
	}
	if (init.name !== undefined) meta.name = init.name
	// Assigned, not passed as defaults: defaults alone are never written.
	let data = liveFiles.liveFile<Record<string, any>>(metaPath(id), {}, { watch: false })
	Object.assign(data, meta)
	liveFiles.save(data)
	sessions.state.open.set(id, data as SessionMeta)
	return data as SessionMeta
}

// The open session's metadata; opens it from disk if needed.
function open(id: string): SessionMeta {
	let existing = sessions.state.open.get(id)
	if (existing) return existing
	let meta = sessions.load(id, false)
	sessions.state.open.set(id, meta)
	return meta
}

// Writes pending changes and forgets the session; it stays on disk.
function close(id: string): void {
	let meta = sessions.state.open.get(id)
	if (!meta) return
	sessions.state.open.delete(id)
	liveFiles.close(meta)
}

function closeAll(): void {
	for (let id of [...sessions.state.open.keys()]) sessions.close(id)
}

// Open ids in the order they were opened.
function openIds(): string[] {
	return [...sessions.state.open.keys()]
}

// Every session directory on disk, open or not. Read-only: a broken one
// is listed with its error rather than skipped or repaired.
function list(): SessionListing[] {
	if (!existsSync(paths.sessionsDir())) return []
	let out: SessionListing[] = []
	for (let entry of readdirSync(paths.sessionsDir(), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue
		let id = entry.name
		let open = sessions.state.open.get(id)
		if (open) {
			out.push({ id, meta: { ...open } })
			continue
		}
		try {
			let meta = sessions.load(id, false)
			liveFiles.close(meta)
			out.push({ id, meta: { ...meta } })
		} catch (e: any) {
			out.push({ id, error: String(e?.message ?? e) })
		}
	}
	return out
}

// The newest readable session, so a restart or another client comes
// back to the same conversation. Found from directory names: only the
// metadata of the newest (and of broken ones newer than it) is read.
function newest(): string | undefined {
	if (!existsSync(paths.sessionsDir())) return undefined
	let dirs = readdirSync(paths.sessionsDir(), { withFileTypes: true }).filter((e) => e.isDirectory() && /^\d+-/.test(e.name))
	for (let id of dirs.map((e) => e.name).sort((a, b) => parseInt(b) - parseInt(a))) {
		if (sessions.state.open.has(id)) return id
		try {
			liveFiles.close(sessions.load(id, false))
			return id
		} catch {}
	}
	return undefined
}

export const sessions = {
	state: { open: new Map<string, SessionMeta>() },
	validate,
	load,
	claimId,
	create,
	open,
	close,
	closeAll,
	openIds,
	list,
	newest,
}
