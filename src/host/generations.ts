// History generations (task e4z): a rewrite of a session's history goes
// to a new file, and session.ason switches to it in one atomic rename,
// so no reader replays a long file to skip what a rewrite removed.
// history.asonl is the first generation; files listed in session.ason's
// `generations` follow, the last one written. Earlier files never change.
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { lines } from '../common/lines.ts'
import type { HistoryRecord } from '../common/replay.ts'
import type { Generation } from '../common/session.ts'
import { replay } from '../common/replay.ts'
import { rebaseDisplay } from '../common/rebase-display.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'

// The session's generations after the first. Read from disk unless the
// session is open: a worker or a closed session has no copy to update.
function list(id: string): Generation[] {
	let open = sessions.state.open.get(id)
	if (open) return open.generations ?? []
	let path = `${paths.sessionDir(id)}/session.ason`
	if (!existsSync(path)) return []
	let meta = ason.parse(readFileSync(path, 'utf8'), { comments: true }) as { generations?: unknown }
	if (meta.generations === undefined) return []
	sessions.validateGenerations(path, meta.generations)
	return meta.generations as Generation[]
}

// The history file the session writes.
function file(id: string): string {
	return `${paths.sessionDir(id)}/${generations.list(id).at(-1)?.file ?? 'history.asonl'}`
}

// Record numbers below this were given out in earlier generations.
function next(id: string): number {
	return generations.list(id).at(-1)?.next ?? 1
}
export type Segment = { session: string; file: string; end: number }

function segments(id: string, name = generations.list(id).at(-1)?.file ?? 'history.asonl', end?: number): Segment[] {
	let path = `${paths.sessionDir(id)}/${name}`
	let g = generations.list(id).find((g) => g.file === name)
	let before = g?.continues
	return [
		...(before ? generations.segments(before.session ?? id, before.file, before.end) : []),
		{ session: id, file: name, end: end ?? (existsSync(path) ? statSync(path).size : 0) },
	]
}

function readFile(segment: Segment): HistoryRecord[] {
	let path = `${paths.sessionDir(segment.session)}/${segment.file}`
	return pages.lines(path, pages.readBytes(path, 0, segment.end), 0).map((l) => l.record)
}

function read(id: string, name?: string): HistoryRecord[] {
	let out: HistoryRecord[] = []
	for (let segment of generations.segments(id, name)) {
		let records =
			segment.session === id && segment.file === generations.list(id).at(-1)?.file && name === undefined
				? history.local(id)
				: generations.readFile(segment)
		if (segment.session !== id)
			records = records
				.filter((r) => r.type !== 'inbox')
				.map((r) => ({ ...r, originSession: r.originSession ?? segment.session }))
		let byNumber = new Map(records.map((r) => [r.n, r]))
		let seen = new Set(out.map((r) => r.n))
		out = [...out.map((r) => byNumber.get(r.n) ?? r), ...records.filter((r) => !seen.has(r.n))]
	}
	return out
}

function resolved(raw: HistoryRecord[]): HistoryRecord[] {
	let kept = new Map(replay.current(raw).map((r) => [r.n, r]))
	return raw.flatMap((r) => {
		if (r.inactive !== undefined) return []
		if (r.type === 'rebase') return [{ ...r, applied: true as const, text: rebaseDisplay.text(r, raw) }]
		return kept.has(r.n) ? [kept.get(r.n)!] : []
	})
}

// Writes `records` as the session's new generation and switches to it.
// `read`: the size of the written file the records were made from; the
// switch is refused if anything was appended since, so nothing is lost.
// The file reaches the disk before session.ason names it; a crash
// before the rename leaves an unlisted file that the next start
// overwrites.
function start(
	id: string,
	records: HistoryRecord[],
	fields: Pick<Generation, 'reason' | 'replaces' | 'continues'>,
	read: number,
): Generation {
	let meta = sessions.open(id)
	let old = history.file(id)
	let size = existsSync(old) ? statSync(old).size : 0
	if (size !== read)
		throw new Error(`${old} changed while it was rewritten (${read} -> ${size} bytes); nothing changed.`)
	let before = meta.generations
	let list = before ?? []
	let g: Generation = {
		file: `history${list.length + 2}.asonl`,
		...fields,
		next: Math.max(generations.next(id), pages.marks(id).next ?? 1, history.state.next.get(old) ?? 1),
		ts: new Date().toISOString(),
	}
	let path = `${paths.sessionDir(id)}/${g.file}`
	writeFileSync(path, records.map((r) => lines.encode(r)).join(''))
	liveFiles.fsync(path)
	meta.generations = [...list, g]
	try {
		liveFiles.save(meta, { durable: true })
	} catch (e) {
		if (before === undefined) delete meta.generations
		else meta.generations = before
		throw e
	}
	history.state.cache.delete(id)
	pages.state.rebased.delete(id)
	return g
}

export const generations = { list, file, next, segments, readFile, read, resolved, start }
