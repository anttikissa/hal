// Lazy history (task bq): opening a session costs what is shown, not the
// size of its history. A snapshot carries the history's tail (whole
// records within a byte budget, starting at a prompt so no turn is cut
// in two) plus the few earlier records its state needs; clients page
// back through the rest by byte offsets from the end.
//
// marks.ason caches offsets needed for state, caught up with each append,
// and the ranges of lines amendments leave out, which are never read.
//
// Reading is written as steps: generators that pause before decoding
// each record, yielding its size in bytes, so one code path serves both
// drivers: `drive` runs them at once, `slices` in slices of about
// sliceMs() that yield to the event loop between them, so decoding a big
// history never blocks it (task 7j). A record too big for what is left
// of a slice starts the next one. Work that fits one slice finishes
// synchronously either way.

import { closeSync, existsSync, openSync, readSync as readFd, statSync } from 'fs'
import { basename } from 'path'
import { ason } from '../common/ason.ts'
import type { Snapshot } from '../common/snapshot.ts'
import { rebaseDisplay } from '../common/rebase-display.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { amendments } from './amendments.ts'
import { changedFiles } from './changed-files.ts'
import { turnMarks } from './turn-marks.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { pageSlices } from './page-slices.ts'
import { historyTail, type TailMarks } from './history-tail.ts'

// `next`: past the highest record number (HistoryRecord `n`).
// `file`: the history file covered; absent, history.asonl.
// `rebase`: the latest rewrite that readers replay the whole history
// for: a rebase other than an amendment, or a legacy `replaces` prompt;
// once there is one, every later rebase.
// `reply`: the latest assistant text, unless a user record followed it.
// `inactive`: the byte ranges of the lines amendments leave out (task
// e4z), and `dropped` the numbers of their records.
export type Marks = TailMarks & {
	version?: 4
	latestRebase?: number
	file?: string
	rebase?: number
	transitions?: number[]
	size: number
	next?: number
	question?: number
	turnQuestion?: string
	answer?: number
	turn?: number
	ended?: number
	prompt?: number
	reply?: number
	inbox: Record<string, number | number[]>
	changes?: number[]
	files?: number
	inactive?: Range[]
	dropped?: number[]
	// Values derived from a rebased history (kept()), for its size.
	kept?: { size: number; values: Record<string, unknown> }
}
export type Range = [start: number, end: number]
type Raw = { offset: number; bytes: number; text: string }
type Line = { offset: number; bytes: number; record: HistoryRecord }
// `end`: the byte the page (or tail) ends at.
export type Page = { records: HistoryRecord[]; start: number; end: number }
// `older`: where `history` starts, when earlier records exist.
// `earlier`: records from before it that the session's state needs.
export type Tail = { history: HistoryRecord[]; earlier: HistoryRecord[]; older?: number; end: number }
type Steps<T> = Generator<number, T, void>
// `scanned`: bytes whose line offsets are known; `size`: what `list` covers.
// `display`: snapshots.build's rewrites and dropped, for the same size.
type Rebased = {
	scanned: number
	offsets: number[]
	size: number
	records: HistoryRecord[]
	list: HistoryRecord[]
	shown: Map<number | undefined, HistoryRecord>
	current: Map<number | undefined, HistoryRecord>
	display?: { rewrites: Snapshot['rewrites']; dropped: number[] }
}

const NL = 10

function drive<T>(steps: Steps<T>): T {
	for (;;) {
		let r = steps.next()
		if (r.done) return r.value
	}
}

// Bytes [start, end) of a history file. Every lazy read goes through
// here, so what opening a session costs can be counted.
function readBytes(path: string, start: number, end: number): Buffer {
	let buf = Buffer.alloc(Math.max(0, end - start))
	if (!buf.length) return buf
	let fd = openSync(path, 'r')
	try {
		let n = readFd(fd, buf, 0, buf.length, start)
		pages.state.bytesRead += n
		return n < buf.length ? buf.subarray(0, n) : buf
	} finally {
		closeSync(fd)
	}
}

// The record on the line at `offset`. One from an old history, without
// a number, is numbered by its place: offset + 1 (HistoryRecord `n`).
function parse(path: string, text: string, offset: number): HistoryRecord {
	try {
		let r = history.check(ason.parse(text))
		r.n ??= offset + 1
		return r
	} catch (e: any) {
		throw new Error(`${path}: malformed history: ${e?.message ?? e}`)
	}
}

// The complete lines of `buf`, read from file offset `base`, from its
// first byte on (the caller drops a leading fragment), not decoded yet.
function* raw(buf: Buffer, base: number): Generator<Raw, void, void> {
	for (let at = 0; ;) {
		let nl = buf.indexOf(NL, at)
		if (nl < 0) return
		let text = buf.toString('utf8', at, nl)
		if (text.trim()) yield { offset: base + at, bytes: nl + 1 - at, text }
		at = nl + 1
	}
}

const decode = (path: string, r: Raw): Line => ({
	offset: r.offset,
	bytes: r.bytes,
	record: pages.parse(path, r.text, r.offset),
})

// The lines of `buf` (as raw()), decoded.
function lines(path: string, buf: Buffer, base: number): Line[] {
	return [...pages.raw(buf, base)].map((r) => decode(path, r))
}

// The record whose line starts at `offset`.
function lineAt(path: string, offset: number): Line {
	for (let n = 4096; ; n *= 2) {
		let buf = pages.readBytes(path, offset, offset + n)
		let nl = buf.indexOf(NL)
		if (nl >= 0) return { offset, bytes: nl + 1, record: pages.parse(path, buf.toString('utf8', 0, nl), offset) }
		if (buf.length < n) throw new Error(`${path}: no record at ${offset}`)
	}
}

// The newest whole record matching `pred`, read backwards a chunk at a
// time, so it costs what lies after that record, not the whole history.
function findLast(id: string, pred: (r: HistoryRecord) => boolean): HistoryRecord | undefined {
	let path = history.file(id)
	if (!existsSync(path)) return undefined
	let m = pages.marks(id)
	let end = statSync(path).size
	let carry = Buffer.alloc(0)
	while (end > 0) {
		let from = Math.max(0, end - 65536)
		let buf = Buffer.concat([pages.readBytes(path, from, end), carry])
		// Bytes before the first newline belong to a line starting earlier.
		let start = from === 0 ? 0 : buf.indexOf(NL) + 1
		let whole = from > 0 && start === 0 ? [] : [...pages.raw(buf.subarray(start), from + start)]
		for (let i = whole.length - 1; i >= 0; i--) {
			if (amendments.inactiveAt(m, whole[i]!.offset)) continue
			let r = pages.parse(path, whole[i]!.text, whole[i]!.offset)
			if (pred(r)) return r
		}
		carry = start === 0 ? buf : buf.subarray(0, start)
		end = from
	}
	return undefined
}

function apply(m: Marks, r: HistoryRecord, offset: number, path: string): void {
	if (
		(r.type === 'rebase' && !r.applied && (m.rebase !== undefined || !amendments.is(r))) ||
		(r.type === 'user' && r.replaces)
	)
		m.rebase = offset
	if (r.type === 'rebase' && r.inactive === undefined) m.latestRebase = offset
	historyTail.mark(m, r, offset)
	m.next = Math.max(m.next ?? 1, (r.n ?? offset + 1) + 1)
	changedFiles.apply(m, r, offset, path)
	if (r.inactive === undefined) turnMarks.follow(m, r, offset)
}

// Where each non-blank line of `buf`, read from file offset `base`,
// starts and ends.
function bounds(buf: Buffer, base: number): Range[] {
	let out: Range[] = []
	for (let at = 0, nl; (nl = buf.indexOf(NL, at)) >= 0; at = nl + 1)
		if (buf.subarray(at, nl).some((b) => b > 32)) out.push([base + at, base + nl + 1])
	return out
}

function marksPath(id: string): string {
	return `${paths.sessionDir(id)}/marks.ason`
}

// The session's marks as last kept, loaded once; a malformed file is
// left alone and the marks kept in memory only.
function load(id: string): Marks {
	let path = pages.marksPath(id)
	let m = pages.state.marks.get(path)
	if (m) return m
	try {
		m = liveFiles.liveFile<Marks>(path, { size: -1, inbox: {} }, { watch: false })
	} catch {
		m = { size: -1, inbox: {} }
	}
	pages.state.marks.set(path, m)
	return m
}

// The marks, caught up with everything now in the history file.
function marks(id: string): Marks {
	return drive(pages.catchUp(id))
}

// Steps catching the marks up, a record at a time, reading at most
// chunk() bytes at once. Between steps the marks cover whole records
// (`size` moves with each), so sliced catching up may interleave with
// note() and marks(): whoever moved `size` meanwhile is followed.
function* catchUp(id: string): Steps<Marks> {
	let path = history.file(id)
	let m = pages.load(id)
	// Amendments caught up with: the turn state is found again at the end.
	let amended = false
	let done = () => {
		if (amended && m.rebase === undefined) amendments.apply(id, m, path, m.size)
		return m
	}
	for (;;) {
		let size = existsSync(path) ? statSync(path).size : 0
		let file = basename(path)
		// Marks of another version or history file (task e4z) are rebuilt.
		changedFiles.upgrade(m)
		if (m.size < 0 || m.size > size || (m.file ?? 'history.asonl') !== file || (m.size > 0 && m.version !== 4)) {
			for (let key of Object.keys(m)) delete (m as Record<string, unknown>)[key]
			Object.assign(m, { size: 0, inbox: {}, version: 4 }, file !== 'history.asonl' && { file })
			changedFiles.reset(m)
		}
		if (m.size >= size) return done()
		let base = m.size
		let buf = pages.readBytes(path, base, Math.min(size, base + pages.chunk))
		for (let n = pages.chunk * 2; buf.indexOf(NL) < 0 && base + buf.length < size; n *= 2)
			buf = pages.readBytes(path, base, Math.min(size, base + n))
		// Only a torn last line is left.
		if (buf.indexOf(NL) < 0) return done()
		let at = base
		for (let r of pages.raw(buf, base)) {
			yield r.bytes
			if (m.size !== at) break
			let line = decode(path, r)
			pages.apply(m, line.record, line.offset, path)
			m.size = at = line.offset + line.bytes
			if (amendments.is(line.record)) amended = true
		}
		// Blank lines after the last record: the marks cover them too.
		if (m.size === at) m.size = base + buf.lastIndexOf(NL) + 1
	}
}

// history.append wrote `line` (with `record`) at the end of the file:
// the marks follow if they covered everything before it.
function note(id: string, line: string, record: HistoryRecord): void {
	let bytes = Buffer.byteLength(line)
	let size = statSync(history.file(id)).size
	let m = pages.load(id)
	if (m.size < 0 && size === bytes) m.size = 0
	let path = history.file(id)
	if (m.size !== size - bytes || (m.file ?? 'history.asonl') !== basename(path)) return
	pages.apply(m, record, m.size, path)
	m.size = size
	if (amendments.is(record) && m.rebase === undefined) amendments.apply(id, m, path, size)
}

function marked(id: string): Line[] {
	return drive(pages.markedSteps(id))
}

function* markedSteps(id: string): Steps<Line[]> {
	let m = yield* pages.catchUp(id)
	let path = history.file(id)
	let out: Line[] = []
	for (let o of turnMarks.picked(m)) {
		yield 0
		out.push(pages.lineAt(path, o))
	}
	return out
}

// `compute`d from the history; a rebased history's value is kept with
// its marks for their size: replaying every rebased tab's whole history
// made a new host spend seconds and gigabytes before it served the tabs.
function kept<T>(id: string, key: string, compute: () => T): T {
	let m = pages.marks(id)
	if (m.rebase === undefined) return compute()
	if (m.kept?.size !== m.size) m.kept = { size: m.size, values: {} }
	if (!(key in m.kept.values)) m.kept.values[key] = compute()
	// A copy: the marks are a live file, saved when changed.
	return JSON.parse(JSON.stringify(m.kept.values[key]))
}

// The few records the session's state needs, oldest first: from them
// alone, states.fromHistory, inbox.pending and forms.open answer as
// they would from the whole history. A rebased history's are picked from
// its current records, as marks over them would.
function essentials(id: string): HistoryRecord[] {
	if (pages.marks(id).rebase === undefined) return pages.marked(id).map((l) => l.record)
	return pages.kept(id, 'essentials', () => {
		let current = [...pages.rebased(id).current.values()]
		let virtual: Marks = { size: 0, inbox: {} }
		current.forEach((r, i) => turnMarks.follow(virtual, r, i))
		return turnMarks.picked(virtual).map((i) => current[i]!)
	})
}

// A rebased session's records (history.readSync, cached while open), the
// offset of each record line and the current projection, computed once
// per history size instead of reparsing the whole file per page.
function rebased(id: string): Rebased {
	let path = history.file(id)
	let size = existsSync(path) ? statSync(path).size : 0
	let records = history.readSync(id)
	for (let key of pages.state.rebased.keys()) if (!history.state.cache.has(key)) pages.state.rebased.delete(key)
	let c = pages.state.rebased.get(id)
	if (!c || c.scanned > size)
		c = { scanned: 0, offsets: [], size: -1, records: [], list: [], shown: new Map(), current: new Map() }
	let buf = pages.readBytes(path, c.scanned, size)
	for (let [start] of pages.bounds(buf, c.scanned)) c.offsets.push(start)
	c.scanned += buf.lastIndexOf(NL) + 1
	if (c.size !== c.scanned) {
		c.records = records.slice(0, c.offsets.length)
		c.list = rebaseDisplay.current(c.records)
		c.shown = new Map(c.list.map((r) => [r.n, r]))
		c.current = new Map(replay.current(c.records).map((r) => [r.n, r]))
		c.size = c.scanned
		c.display = undefined
	}
	if (history.state.cache.has(id)) pages.state.rebased.set(id, c)
	return c
}

// Whether a (non-replacing) prompt starts a turn here.
const turnStart = (r: HistoryRecord) => replay.isPrompt(r) && !(r.type === 'user' && r.replaces)

// Whole records ending at byte `before` (default: the end of the file),
// oldest first, reading about `budget` bytes, starting at a turn's
// prompt when one is in reach. `start`: where the first record starts;
// 0 when nothing earlier is left. Never empty unless the history is.
function page(id: string, before?: number, budget = pages.budget): Page {
	return drive(pages.pageSteps(id, before, budget))
}

function* pageSteps(id: string, before?: number, budget = pages.budget): Steps<Page> {
	let path = history.file(id)
	let size = existsSync(path) ? statSync(path).size : 0
	let end = before ?? size
	if (end > size || end < 0 || (before !== undefined && end > 0 && pages.readBytes(path, end - 1, end)[0] !== NL))
		throw new Error(`${path}: ${before} is not a record boundary`)
	// Rebase undo and cross-page groups need the audit trail, unless the
	// page lies wholly after the last rebase: replaying the whole history
	// for each tab's latest reply cost a new host seconds and gigabytes.
	let m = pages.marks(id)
	if (m.rebase !== undefined) {
		let linear = yield* pages.linearSteps(path, end, budget)
		if (linear.start > m.rebase) return linear
		let { records, offsets, shown: current } = pages.rebased(id)
		let found = records
			.map((record, i) => ({ offset: offsets[i]!, record }))
			.filter((l) => l.offset < end && l.record.type !== 'rebase' && current.has(l.record.n))
		let at = found.findIndex((l) => l.offset >= end - budget)
		if (at < 0) at = Math.max(0, found.length - 1)
		let turn = at > 0 ? found.findIndex((l, i) => i >= at && turnStart(l.record)) : -1
		if (turn >= 0) at = turn
		found = found.slice(at)
		return { records: found.map((l) => current.get(l.record.n)!), start: found[0]?.offset ?? 0, end }
	}
	return yield* pages.linearSteps(path, end, budget, m.inactive)
}

// Reads back from `end` about `budget` bytes of the lines outside the
// `inactive` ranges, which are never read.
function* linearSteps(path: string, end: number, budget: number, inactive: Range[] = []): Steps<Page> {
	let total = amendments.spans(inactive, 0, end).reduce((sum, [s, e]) => sum + e - s, 0)
	for (let n = Math.min(Math.max(budget, 1), total); ; n = Math.min(n * 2, total)) {
		let from = amendments.back(inactive, end, n, total)
		// Lines start at 0 and where inactive ranges end; elsewhere the
		// first line read may have started earlier.
		let cut = from > 0 && !inactive.some(([, e]) => e === from)
		let found: Line[] = []
		for (let [s, e] of amendments.spans(inactive, from, end)) {
			let buf = pages.readBytes(path, s, e)
			let skip = s === from && cut ? buf.indexOf(NL) + 1 : 0
			if (s === from && cut && !skip) continue
			for (let r of pages.raw(buf.subarray(skip), s + skip)) {
				yield r.bytes
				found.push(decode(path, r))
			}
		}
		if (!found.length && from > 0) continue
		if (from > 0) {
			let at = found.findIndex((l) => turnStart(l.record))
			if (at > 0) found = found.slice(at)
		}
		return { records: found.map((l) => l.record), start: found[0]?.offset ?? 0, end }
	}
}

// What a client opening the session gets of its history.
function snapshot(id: string, budget = pages.budget): Tail {
	return drive(pages.snapshotSteps(id, budget))
}

function* snapshotSteps(id: string, budget = pages.budget): Steps<Tail> {
	let read = pages.state.bytesRead
	let earlier = yield* pages.markedSteps(id)
	if (pages.marks(id).rebase !== undefined) {
		let { current } = pages.rebased(id)
		earlier = earlier.filter((l) => current.has(l.record.n)).map((l) => ({ ...l, record: current.get(l.record.n)! }))
	}
	let used = pages.state.bytesRead - read
	let tail = yield* pages.pageSteps(id, undefined, Math.max(budget - used, 1))
	let out: Tail = {
		history: tail.records,
		earlier: earlier.filter((l) => l.offset < tail.start).map((l) => l.record),
		end: tail.end,
	}
	if (tail.start > 0 && !tail.records.some((r) => r.type === 'reset')) out.older = tail.start
	return out
}

// `tail` with whatever was appended to the history since it was read
// (a sliced snapshot takes a while): those records join its history, and
// the earlier records are found again, as the marks may have moved.
function since(id: string, tail: Tail): Tail {
	let path = history.file(id)
	let size = existsSync(path) ? statSync(path).size : 0
	if (size <= tail.end) return tail
	let m = pages.marks(id)
	let read = [...pages.raw(pages.readBytes(path, tail.end, size), tail.end)]
	let more = read.filter((r) => !amendments.inactiveAt(m, r.offset)).map((r) => decode(path, r))
	let start = tail.older ?? 0
	let earlier =
		tail.older === undefined
			? []
			: pages
					.marked(id)
					.filter((l) => l.offset < start)
					.map((l) => l.record)
	return {
		...tail,
		history: [...tail.history, ...more.map((l) => l.record)],
		earlier,
		end: read.length ? read.at(-1)!.offset + read.at(-1)!.bytes : tail.end,
	}
}

// Forgets (and writes) every session's marks (tests, a closing host).
function reset(): void {
	for (let m of pages.state.marks.values()) {
		try {
			liveFiles.close(m)
		} catch {}
	}
	pages.state.marks.clear()
	pages.state.rebased.clear()
}

export const pages = {
	// `bytesRead`: history bytes read lazily so far. `marks`: by path.
	// `until`: when this turn's slice of sliced work ends.
	state: {
		bytesRead: 0,
		marks: new Map<string, Marks>(),
		rebased: new Map<string, Rebased>(),
		until: undefined as number | undefined,
	},
	// About how many bytes of history a snapshot or a page reads.
	budget: 256 * 1024,
	// The longest stretch sliced reading runs without yielding.
	sliceMs: 5,
	// Reading this much or less is never sliced.
	syncBytes: 64 * 1024,
	// About how long decoding a megabyte of history takes.
	msPerMB: 4,
	// How much history catching up the marks reads at once.
	chunk: 4 * 1024 * 1024,
	drive,
	deadline: (): number => pageSlices.deadline(),
	slices: <T>(steps: Steps<T>): T | Promise<T> => pageSlices.slices(steps),
	readBytes,
	parse,
	raw,
	lines,
	lineAt,
	findLast,
	apply,
	bounds,
	marksPath,
	load,
	marks,
	catchUp,
	note,
	marked,
	markedSteps,
	kept,
	linearSteps,
	essentials,
	rebased,
	page,
	pageSteps,
	snapshot,
	snapshotSteps,
	since,
	reset,
}
