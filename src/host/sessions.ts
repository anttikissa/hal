// Sessions: one directory per session under sessions/, with its metadata
// in session.ason. Open sessions hold that file as a liveFile, so edits
// to the returned object persist. The host may keep several open at once.
// A session needs no history to be valid. Malformed metadata is reported
// and left on disk untouched; it is never replaced with defaults.

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import type { SessionMeta } from '../common/session.ts'
import { names } from '../common/names.ts'
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
	if (data.closedAt !== undefined && (typeof data.closedAt !== 'string' || !Number.isFinite(Date.parse(data.closedAt)))) throw new Error(`${path}: invalid closedAt`)
	if (data.name !== undefined && typeof data.name !== 'string') throw new Error(`${path}: invalid name`)
	if (data.nameOwner !== undefined && data.nameOwner !== 'auto' && data.nameOwner !== 'manual') throw new Error(`${path}: invalid nameOwner`)
	for (let key of ['nameVersion', 'nameTurns']) if (data[key] !== undefined && (!Number.isSafeInteger(data[key]) || data[key] < 0)) throw new Error(`${path}: invalid ${key}`)
	if (data.previousCwd !== undefined && typeof data.previousCwd !== 'string') throw new Error(`${path}: invalid previousCwd`)
	if (data.effort !== undefined && typeof data.effort !== 'string') throw new Error(`${path}: invalid effort`)
	let bg = data.background
	if (bg !== undefined && !(Array.isArray(bg) && bg.every((b) => typeof b === 'string'))) throw new Error(`${path}: background must be a list of ids`)
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

// "<day>-<word>" (tasks/tn). A Hal day runs 05:00-05:00 local time;
// day 1 holds the home's epoch (state/epoch.ason, the first session's
// UTC time). The word comes from session-words.txt cut into 24 slots,
// slot 0 at 05:00, so a day's ids list roughly in creation order:
// three tries in this hour's slot, two more with its neighbors, five
// from the whole list, then random letters. The directory is claimed
// with a non-recursive mkdir, so two creators never share one.
function claimId(now = new Date()): string {
	mkdirSync(paths.sessionsDir(), { recursive: true })
	mkdirSync(paths.stateDir(), { recursive: true })
	let epochFile = liveFiles.liveFile<{ epoch?: string }>(`${paths.stateDir()}/epoch.ason`, {}, { watch: false })
	if (!epochFile.epoch) epochFile.epoch = now.toISOString()
	let epoch = new Date(epochFile.epoch)
	liveFiles.close(epochFile)
	if (Number.isNaN(epoch.getTime())) throw new Error(`${paths.stateDir()}/epoch.ason: invalid epoch`)
	let halDay = (t: Date) => {
		let d = new Date(t.getTime() - 5 * 3_600_000)
		return { date: Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000, hour: d.getHours() }
	}
	let { date, hour } = halDay(now)
	let dayNo = Math.max(1, date - halDay(epoch).date + 1)
	let day = String(dayNo).padStart(2, '0')
	let extra = { 3: ['cpo'], 49: ['ers'], 123: ['ntp'], 179: ['bgp'], 445: ['smb'], 631: ['ipp'] }[dayNo] ?? []
	let words = [...new Set([...readFileSync(`${import.meta.dir}/session-words.txt`, 'utf8').split(/\s+/).filter(Boolean), ...extra])].sort()
	let slot = (h: number) => words.slice(Math.floor((h * words.length) / 24), Math.floor(((h + 1) * words.length) / 24))
	for (let attempt = 0; ; attempt++) {
		let pool = attempt < 3 ? slot(hour) : attempt < 5 ? [hour - 1, hour, hour + 1].flatMap((h) => (h < 0 || h > 23 ? [] : slot(h))) : words
		let word = attempt < 10 ? pool[Math.floor(Math.random() * pool.length)] : Array.from({ length: 3 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')
		let id = `${day}-${word}`
		try {
			mkdirSync(paths.sessionDir(id))
			return id
		} catch (e: any) {
			if (e?.code !== 'EEXIST') throw e
		}
	}
}

function create(init: { cwd: string; model?: string; name?: string }): SessionMeta {
	let selection = models.selection(init.model ?? models.defaultModel())
	let id = sessions.claimId()
	let meta: SessionMeta = {
		id,
		cwd: init.cwd,
		model: selection.id,
		...(selection.effort !== undefined && { effort: selection.effort }),
		createdAt: new Date().toISOString(),
	}
	meta.name = init.name ? names.validate(init.name) : names.fallback(id)
	meta.nameVersion = 0
	meta.nameTurns = 0
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
	if (!meta.name?.trim() || meta.name === id) meta.name = names.fallback(id)
	liveFiles.save(meta)
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
	for (let id of sessions.state.open.keys()) sessions.close(id)
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
// back to the same conversation. Directory names give the day; only
// the metadata of that day's sessions (and of broken newer ones) is
// read, and the latest createdAt wins.
function newest(): string | undefined {
	if (!existsSync(paths.sessionsDir())) return undefined
	let dirs = readdirSync(paths.sessionsDir(), { withFileTypes: true }).filter((e) => e.isDirectory() && /^\d+-/.test(e.name))
	let best: { id: string; at: string } | undefined
	for (let id of dirs.map((e) => e.name).sort((a, b) => parseInt(b) - parseInt(a))) {
		if (best && parseInt(id) < parseInt(best.id)) break
		let at = sessions.state.open.get(id)?.createdAt
		if (at === undefined) {
			try {
				let meta = sessions.load(id, false)
				at = meta.createdAt
				liveFiles.close(meta)
			} catch {
				continue
			}
		}
		if (!best || at > best.at) best = { id, at }
	}
	return best?.id
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
