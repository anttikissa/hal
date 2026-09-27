// Lazy history (task bq): opening a session costs what is shown, not the
// size of its history. A snapshot carries the history's tail (whole
// records within a byte budget, starting at a prompt so no turn is cut
// in two) plus the few earlier records its state needs; clients page
// back through the rest by byte offsets from the end.
//
// What the state needs from earlier is found through sessions/<id>/
// marks.ason: the offsets of the last question, the last answer or turn
// end, the last record of a turn, the last prompt and every inbox
// message not yet delivered. It is a cache of history, which stays the
// truth: `size` says how much of the file it covers, and whatever was
// appended since is read and folded in; a file shorter than that, or no
// marks at all, rebuilds it from the whole history.

import { closeSync, existsSync, openSync, readSync as readFd, statSync } from 'fs'
import { ason } from '../common/ason.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

// `next`: past the highest record number (HistoryRecord `n`).
type Marks = { size: number; next?: number; question?: number; turnQuestion?: string; close?: number; turn?: number; prompt?: number; inbox: Record<string, number | number[]> }
type Line = { offset: number; bytes: number; record: HistoryRecord }
export type Page = { records: HistoryRecord[]; start: number }
// `older`: where `history` starts, when earlier records exist.
// `earlier`: records from before it that the session's state needs.
export type Tail = { history: HistoryRecord[]; earlier: HistoryRecord[]; older?: number }

const NL = 10

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
// first byte on (the caller drops a leading fragment).
function lines(path: string, buf: Buffer, base: number): Line[] {
	let out: Line[] = []
	for (let at = 0; ; ) {
		let nl = buf.indexOf(NL, at)
		if (nl < 0) return out
		let text = buf.toString('utf8', at, nl)
		if (text.trim()) out.push({ offset: base + at, bytes: nl + 1 - at, record: pages.parse(path, text, base + at) })
		at = nl + 1
	}
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

function apply(m: Marks, r: HistoryRecord, offset: number): void {
	m.next = Math.max(m.next ?? 1, (r.n ?? offset + 1) + 1)
	if (r.type === 'question') {
		m.question = offset
		if (!r.from) {
			m.turnQuestion = r.id
			m.turn = offset
		}
	} else if (r.type === 'answer' || r.type === 'turn_end') {
		m.close = offset
		if (r.type === 'turn_end' || r.question === m.turnQuestion) m.turn = offset
	} else if (r.type === 'inbox' && r.withdrawn) delete m.inbox[r.id]
	// Every record of a message: an edit keeps the place of the first.
	else if (r.type === 'inbox') m.inbox[r.id] = [...[m.inbox[r.id] ?? []].flat(), offset]
	else if (r.type === 'user' || r.type === 'assistant' || r.type === 'continue') {
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
	let path = history.file(id)
	let size = existsSync(path) ? statSync(path).size : 0
	let m = pages.load(id)
	if (m.size < 0 || m.size > size || (m.size > 0 && m.next === undefined)) {
		for (let key of Object.keys(m)) delete (m as Record<string, unknown>)[key]
		Object.assign(m, { size: 0, inbox: {} })
	}
	if (m.size < size) {
		let found = pages.lines(path, pages.readBytes(path, m.size, size), m.size)
		for (let line of found) pages.apply(m, line.record, line.offset)
		let last = found.at(-1)
		if (last) m.size = last.offset + last.bytes
	}
	return m
}

// history.append wrote `line` (with `record`) at the end of the file:
// the marks follow if they covered everything before it.
function note(id: string, line: string, record: HistoryRecord): void {
	let bytes = Buffer.byteLength(line)
	let size = statSync(history.file(id)).size
	let m = pages.load(id)
	if (m.size < 0 && size === bytes) m.size = 0
	if (m.size !== size - bytes) return
	pages.apply(m, record, m.size)
	m.size = size
}

function marked(id: string): Line[] {
	let m = pages.marks(id)
	let offsets = new Set([m.question, m.close, m.turn, m.prompt, ...Object.values(m.inbox).flat()].filter((o) => o !== undefined))
	let path = history.file(id)
	return [...offsets].sort((a, b) => a - b).map((o) => pages.lineAt(path, o))
}

// The few records the session's state needs, oldest first: from them
// alone, states.fromHistory, inbox.pending and forms.open answer as
// they would from the whole history.
function essentials(id: string): HistoryRecord[] {
	return pages.marked(id).map((l) => l.record)
}

// Whether a (non-replacing) prompt starts a turn here.
const turnStart = (r: HistoryRecord) => replay.isPrompt(r) && !(r.type === 'user' && r.replaces)

// Whole records ending at byte `before` (default: the end of the file),
// oldest first, reading about `budget` bytes, starting at a turn's
// prompt when one is in reach. `start`: where the first record starts;
// 0 when nothing earlier is left. Never empty unless the history is.
function page(id: string, before?: number, budget = pages.budget()): Page {
	let path = history.file(id)
	let size = existsSync(path) ? statSync(path).size : 0
	let end = before ?? size
	if (end > size || end < 0 || (before !== undefined && end > 0 && pages.readBytes(path, end - 1, end)[0] !== NL)) throw new Error(`${path}: ${before} is not a record boundary`)
	for (let n = Math.min(Math.max(budget, 1), end); ; n = Math.min(n * 2, end)) {
		let from = end - n
		let buf = pages.readBytes(path, from, end)
		let skip = from === 0 ? 0 : buf.indexOf(NL) + 1
		let found = skip > 0 || from === 0 ? pages.lines(path, buf.subarray(skip), from + skip) : []
		if (!found.length && from > 0) continue
		if (from > 0) {
			let at = found.findIndex((l) => turnStart(l.record))
			if (at > 0) found = found.slice(at)
		}
		return { records: found.map((l) => l.record), start: found[0]?.offset ?? 0 }
	}
}

// What a client opening the session gets of its history.
function snapshot(id: string, budget = pages.budget()): Tail {
	let read = pages.state.bytesRead
	let earlier = pages.marked(id)
	let used = pages.state.bytesRead - read
	let tail = pages.page(id, undefined, Math.max(budget - used, 1))
	let out: Tail = { history: tail.records, earlier: earlier.filter((l) => l.offset < tail.start).map((l) => l.record) }
	if (tail.start > 0) out.older = tail.start
	return out
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
	state: { bytesRead: 0, marks: new Map<string, Marks>() },
	// About how many bytes of history a snapshot or a page reads.
	budget: () => 256 * 1024,
	readBytes,
	parse,
	lines,
	lineAt,
	apply,
	marksPath,
	load,
	marks,
	note,
	marked,
	essentials,
	page,
	snapshot,
	reset,
}
