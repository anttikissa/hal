// Rewrites only an amended tail and its marks, leaving the prefix untouched.
import { closeSync, ftruncateSync, openSync, statSync, writeSync } from 'fs'
import { lines } from '../common/lines.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { amendments } from './amendments.ts'
import { changedFiles } from './changed-files.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { pages, type Marks } from './pages.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'

// Marks before the latest prompt and amendment, so a rewrite of the tail
// after them needs no read of the prefix; `legacyAmend`: the file holds
// old append-only amendments, so a tail rewrite reads its prefix instead.
export type TailMarks = {
	beforePrompt?: { offset: number; marks: PrefixMarks }
	beforeAmend?: { offset: number; n: number; marks: PrefixMarks }
	legacyAmend?: true
}
export type PrefixMarks = Omit<Marks, keyof TailMarks | 'kept'>

function capture(m: Marks): PrefixMarks {
	return JSON.parse(
		JSON.stringify(
			Object.fromEntries(Object.entries(m).filter(([key]) => !['beforePrompt', 'beforeAmend', 'kept'].includes(key))),
		),
	)
}

// Records in `m` what a tail rewrite needs: the marks before the latest
// prompt and amendment, and the lines amendments left out.
function mark(m: Marks, r: HistoryRecord, offset: number): void {
	if (amendments.is(r)) m.legacyAmend = true
	if (r.type === 'rebase' && r.applied && r.removed) m.dropped = [...r.removed]
	if (r.inactive !== undefined && r.inactive > (m.beforeAmend?.n ?? 0))
		m.beforeAmend = { offset, n: r.inactive, marks: historyTail.capture(m) }
	if (!m.legacyAmend && r.inactive === undefined && replay.isPrompt(r))
		m.beforePrompt = { offset, marks: historyTail.capture(m) }
	if (r.inactive === undefined) return
	let end = offset + Buffer.byteLength(lines.encode(r))
	let last = m.inactive?.at(-1)
	if (last?.[1] === offset) last[1] = end
	else (m.inactive ??= []).push([offset, end])
	;(m.dropped ??= []).push(r.n!)
}

function prefix(id: string, offset: number): PrefixMarks {
	let m = pages.marks(id)
	for (let saved of [m.beforePrompt, m.beforeAmend])
		if (saved?.offset === offset) return historyTail.capture(saved.marks)
	let path = history.file(id)
	let before: Marks = { size: 0, inbox: {}, version: 4, file: m.file }
	for (let line of pages.lines(path, pages.readBytes(path, 0, offset), 0))
		pages.apply(before, line.record, line.offset, path)
	before.size = offset
	return historyTail.capture(before)
}

function read(id: string, n?: number): { offset: number; records: HistoryRecord[] } {
	let path = history.file(id),
		m = pages.marks(id)
	let offset = m.prompt ?? 0
	if (n !== undefined && pages.lineAt(path, offset).record.n !== n) {
		// A rewind may target an older turn; the ordinary amend uses its mark.
		let found = pages
			.lines(path, pages.readBytes(path, 0, m.size), 0)
			.find((l) => l.record.n === n && l.record.inactive === undefined)
		if (!found) throw new Error(`u${n} is not a prompt in the active history (rewritten meanwhile?).`)
		offset = found.offset
	}
	return { offset, records: pages.lines(path, pages.readBytes(path, offset, m.size), offset).map((l) => l.record) }
}

function write(id: string, offset: number, records: HistoryRecord[], before = historyTail.prefix(id, offset)): void {
	let path = history.file(id),
		size = statSync(path).size
	let first = pages.lineAt(path, offset).record.n
	let bytes = Buffer.from(records.map((r) => lines.encode(r)).join(''))
	let fd = openSync(path, 'r+')
	try {
		let written = writeSync(fd, bytes, 0, bytes.length, offset)
		if (written !== bytes.length) throw new Error(`${path}: wrote ${written} of ${bytes.length} tail bytes`)
		if (offset + bytes.length < size) ftruncateSync(fd, offset + bytes.length)
	} finally {
		closeSync(fd)
	}
	let cached = history.state.cache.get(id)
	if (cached) {
		let at = cached.records.findIndex((r) => r.n === first)
		if (at >= 0)
			history.state.cache.set(id, {
				size: offset + bytes.length,
				records: [...cached.records.slice(0, at), ...records],
			})
		else history.state.cache.delete(id)
	}
	let m = pages.load(id)
	for (let key of Object.keys(m)) delete (m as Record<string, unknown>)[key]
	Object.assign(m, before, { size: offset })
	changedFiles.state.paths.delete(m)
	changedFiles.state.waiting.delete(m)
	pages.state.rebased.delete(id)
	let at = offset
	for (let r of records) {
		pages.apply(m, r, at, path)
		at += Buffer.byteLength(lines.encode(r))
		m.size = at
	}
	let meta = sessions.open(id)
	meta.historyRevision = (meta.historyRevision ?? 0) + 1
	liveFiles.save(meta)
	liveFiles.save(m)
	status.state.states.delete(id)
	status.state.derived.delete(id)
}

export const historyTail = { capture, mark, prefix, read, write }
