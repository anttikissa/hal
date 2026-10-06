// Lazy history (task bq): opening a session costs what is shown, not the
// size of its history. A snapshot carries the history's tail (whole
// records within a byte budget, starting at a prompt so no turn is cut
// in two) plus the few earlier records its state needs; clients page
// back through the rest by byte offsets from the end.
//
// marks.ason caches offsets needed for state, caught up with each append.
//
// Reading is written as steps: generators that pause before decoding
// each record, yielding its size in bytes, so one code path serves both
// drivers: `drive` runs them at once, `slices` in slices of about
// sliceMs() that yield to the event loop between them, so decoding a big
// history never blocks it (task 7j). A record too big for what is left
// of a slice starts the next one. Work that fits one slice finishes
// synchronously either way.

import { closeSync, existsSync, openSync, readSync as readFd, statSync } from 'fs'
import { ason } from '../common/ason.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { changedFiles } from './changed-files.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

// `next`: past the highest record number (HistoryRecord `n`).
type Marks = { rebaseVersion?: 1; rebase?: number; transitions?: number[]; size: number; next?: number; question?: number; turnQuestion?: string; answer?: number; turn?: number; prompt?: number; inbox: Record<string, number | number[]>; changes?: number[]; files?: number }
type Raw = { offset: number; bytes: number; text: string }
type Line = { offset: number; bytes: number; record: HistoryRecord }
// `end`: the byte the page (or tail) ends at.
export type Page = { records: HistoryRecord[]; start: number; end: number }
// `older`: where `history` starts, when earlier records exist.
// `earlier`: records from before it that the session's state needs.
export type Tail = { history: HistoryRecord[]; earlier: HistoryRecord[]; older?: number; end: number }
type Steps<T> = Generator<number, T, void>

const NL = 10

function drive<T>(steps: Steps<T>): T {
	for (;;) {
		let r = steps.next()
		if (r.done) return r.value
	}
}

// When the sliced work of this turn of the event loop must yield: all
// of it shares one slice of sliceMs(), however many runs there are.
function deadline(): number {
	if (pages.state.until === undefined) {
		pages.state.until = performance.now() + pages.sliceMs
		setImmediate(() => (pages.state.until = undefined))
	}
	return pages.state.until
}

// Runs `steps` in slices, yielding to the event loop between them: the
// value at once if they fit what is left of this turn's slice, or decode
// at most syncBytes() (small reads always finish at once), else a
// promise.
function slices<T>(steps: Steps<T>): T | Promise<T> {
	let decoded = 0
	let run = (): IteratorResult<number, T> | undefined => {
		for (;;) {
			let small = decoded <= pages.syncBytes
			if (!small && performance.now() >= pages.deadline()) return undefined
			let r = steps.next()
			if (r.done) return r
			decoded += r.value
			// A record that would overrun the slice waits for the next,
			// unless the slice has only just begun.
			let now = performance.now()
			let end = pages.deadline()
			if (decoded > pages.syncBytes && now > end - pages.sliceMs + 0.5 && now + (r.value / 1e6) * pages.msPerMB > end) return undefined
		}
	}
	let r = run()
	if (r) return r.value as T
	let next = () => new Promise((resolve) => setImmediate(resolve))
	return (async () => {
		for (;;) {
			await next()
			let r = run()
			if (!r) continue
			// What the caller does with the value gets a slice of its own.
			if (performance.now() >= pages.deadline()) await next()
			return r.value as T
		}
	})()
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
	for (let at = 0; ; ) {
		let nl = buf.indexOf(NL, at)
		if (nl < 0) return
		let text = buf.toString('utf8', at, nl)
		if (text.trim()) yield { offset: base + at, bytes: nl + 1 - at, text }
		at = nl + 1
	}
}

const decode = (path: string, r: Raw): Line => ({ offset: r.offset, bytes: r.bytes, record: pages.parse(path, r.text, r.offset) })

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

function apply(m: Marks, r: HistoryRecord, offset: number, path: string): void {
	if (r.type === 'rebase') m.rebase = offset
	if (r.type === 'output' && r.transition) m.transitions = [offset]
	if (r.type === 'output' && r.transitionCancel) (m.transitions ??= []).push(offset)
	if (r.type === 'output' && r.transitionDone) m.transitions = []
	m.next = Math.max(m.next ?? 1, (r.n ?? offset + 1) + 1)
	changedFiles.apply(m, r, offset, path)
	if (r.type === 'question') {
		m.question = offset
		if (!r.from) {
			m.turnQuestion = r.id
			m.turn = offset
		}
	} else if (r.type === 'answer' || r.type === 'turn_end') {
		// A turn end is the turn's last record; it closes only a turn's
		// question (forms.open), so the last answer is kept apart.
		if (r.type === 'answer') m.answer = offset
		if (r.type === 'turn_end' || r.question === m.turnQuestion) m.turn = offset
	} else if (r.type === 'inbox' && r.withdrawn) delete m.inbox[r.id]
	// Every record of a message: an edit keeps the place of the first.
	else if (r.type === 'inbox') m.inbox[r.id] = [...[m.inbox[r.id] ?? []].flat(), offset]
	else if ((r.type === 'user' && (r.notices === undefined || r.blocks.length)) || r.type === 'assistant' || r.type === 'continue') {
		m.turn = offset
		if (replay.isPrompt(r)) m.prompt = offset
		if (r.type === 'user') for (let id of r.inbox ?? []) delete m.inbox[id]
	}
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
	for (;;) {
		let size = existsSync(path) ? statSync(path).size : 0
		// Marks from before `next`, or with `close` (an answer or a turn
		// end, before answers were kept apart), are rebuilt.
		changedFiles.upgrade(m)
		if (m.size < 0 || m.size > size || (m.size > 0 && (m.next === undefined || m.changes === undefined || !('rebaseVersion' in m))) || 'close' in m) {
			for (let key of Object.keys(m)) delete (m as Record<string, unknown>)[key]
			Object.assign(m, { size: 0, inbox: {}, rebaseVersion: 1 })
			changedFiles.reset(m)
		}
		if (m.size >= size) return m
		let base = m.size
		let buf = pages.readBytes(path, base, Math.min(size, base + pages.chunk))
		for (let n = pages.chunk * 2; buf.indexOf(NL) < 0 && base + buf.length < size; n *= 2) buf = pages.readBytes(path, base, Math.min(size, base + n))
		// Only a torn last line is left.
		if (buf.indexOf(NL) < 0) return m
		let at = base
		for (let r of pages.raw(buf, base)) {
			yield r.bytes
			if (m.size !== at) break
			let line = decode(path, r)
			pages.apply(m, line.record, line.offset, path)
			m.size = at = line.offset + line.bytes
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
	if (m.size !== size - bytes) return
	pages.apply(m, record, m.size, history.file(id))
	m.size = size
}

function marked(id: string): Line[] {
	return drive(pages.markedSteps(id))
}

function* markedSteps(id: string): Steps<Line[]> {
	let m = yield* pages.catchUp(id)
	let offsets = new Set([m.question, m.answer, m.turn, m.prompt, ...Object.values(m.inbox).flat(), ...(m.transitions ?? [])].filter((o) => o !== undefined))
	let path = history.file(id)
	let out: Line[] = []
	for (let o of [...offsets].sort((a, b) => a - b)) {
		yield 0
		out.push(pages.lineAt(path, o))
	}
	return out
}

// The few records the session's state needs, oldest first: from them
// alone, states.fromHistory, inbox.pending and forms.open answer as
// they would from the whole history.
function essentials(id: string): HistoryRecord[] {
	if (pages.marks(id).rebase !== undefined) return replay.current(history.readSync(id))
	return pages.marked(id).map((l) => l.record)
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
	if (end > size || end < 0 || (before !== undefined && end > 0 && pages.readBytes(path, end - 1, end)[0] !== NL)) throw new Error(`${path}: ${before} is not a record boundary`)
	// Rebase undo and cross-page groups need the audit trail.
	if (pages.marks(id).rebase !== undefined) {
		let all = pages.lines(path, pages.readBytes(path, 0, size), 0)
		let current = new Map(replay.current(all.map((l) => l.record)).map((r) => [r.n, r]))
		let found = all.filter((l) => l.offset < end && current.has(l.record.n))
		let at = found.findIndex((l) => l.offset >= end - budget)
		if (at < 0) at = Math.max(0, found.length - 1)
		while (at > 0 && !turnStart(found[at]!.record)) at--
		found = found.slice(at)
		return { records: found.map((l) => current.get(l.record.n)!), start: found[0]?.offset ?? 0, end }
	}
	for (let n = Math.min(Math.max(budget, 1), end); ; n = Math.min(n * 2, end)) {
		let from = end - n
		let buf = pages.readBytes(path, from, end)
		let skip = from === 0 ? 0 : buf.indexOf(NL) + 1
		let found: Line[] = []
		if (skip > 0 || from === 0) {
			for (let r of pages.raw(buf.subarray(skip), from + skip)) {
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
		let current = new Map(replay.current(history.readSync(id)).map((r) => [r.n, r]))
		earlier = earlier.filter((l) => current.has(l.record.n)).map((l) => ({ ...l, record: current.get(l.record.n)! }))
	}
	let used = pages.state.bytesRead - read
	let tail = yield* pages.pageSteps(id, undefined, Math.max(budget - used, 1))
	let out: Tail = { history: tail.records, earlier: earlier.filter((l) => l.offset < tail.start).map((l) => l.record), end: tail.end }
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
	let more = pages.lines(path, pages.readBytes(path, tail.end, size), tail.end)
	let start = tail.older ?? 0
	let earlier = tail.older === undefined ? [] : pages.marked(id).filter((l) => l.offset < start).map((l) => l.record)
	return { ...tail, history: [...tail.history, ...more.map((l) => l.record)], earlier, end: more.length ? more.at(-1)!.offset + more.at(-1)!.bytes : tail.end }
}

// Forgets (and writes) every session's marks (tests, a closing host).
function reset(): void {
	for (let m of pages.state.marks.values()) {
		try {
			liveFiles.close(m)
		} catch {}
	}
	pages.state.marks.clear()
}

export const pages = {
	// `bytesRead`: history bytes read lazily so far. `marks`: by path.
	// `until`: when this turn's slice of sliced work ends.
	state: { bytesRead: 0, marks: new Map<string, Marks>(), until: undefined as number | undefined },
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
	deadline,
	slices,
	readBytes,
	parse,
	raw,
	lines,
	lineAt,
	apply,
	marksPath,
	load,
	marks,
	catchUp,
	note,
	marked,
	markedSteps,
	essentials,
	page,
	pageSteps,
	snapshot,
	snapshotSteps,
	since,
	reset,
}
