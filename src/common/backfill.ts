// Earlier history, fetched after the snapshot (task bq). A snapshot
// holds only the tail of a session's history; a client asks for the
// records before it page by page (`history` commands) and puts them in
// front of its transcript (transcript.prepend). The terminal fetches
// every page in the background and shows them at once; the web fetches
// one when the reader scrolls near the top.

import type { Event } from './protocol.ts'
import type { HistoryRecord } from './replay.ts'
import { transcript, type Transcript } from './transcript.ts'

// Per session: `loaded`, the records the transcript is folded from so
// far; `pages`, records fetched and not shown yet; `older`, where the
// records not fetched end (none: nothing is left); `asked`, the
// `before` of the page asked for and not answered yet; `earlier`, the
// snapshot's records from further back (as JSON), shown on top until a
// page holds them.
export type Backfill = { loaded: HistoryRecord[]; pages: HistoryRecord[]; earlier: string[]; older?: number; asked?: number }

type Sessions = Map<string, Backfill>

// A snapshot starts over: what was fetched before may be stale.
function onSnapshot(all: Sessions, event: Event & { type: 'snapshot' }): void {
	let b: Backfill = { loaded: event.snapshot.history, pages: [], earlier: (event.snapshot.earlier ?? []).map((r) => JSON.stringify(r)) }
	if (event.snapshot.older !== undefined) b.older = event.snapshot.older
	all.set(event.sessionId, b)
}

// The command asking for the next page, unless one is asked already or
// nothing is left.
function next(all: Sessions, sessionId: string): { type: 'history'; sessionId: string; before: number } | undefined {
	let b = all.get(sessionId)
	if (!b || b.older === undefined || b.asked !== undefined) return undefined
	b.asked = b.older
	return { type: 'history', sessionId, before: b.older }
}

// Takes a page; false if it answers nothing asked since the snapshot.
function onPage(all: Sessions, event: Event & { type: 'history' }): boolean {
	let b = all.get(event.sessionId)
	if (!b || b.asked !== event.before) return false
	b.pages = [...event.records, ...b.pages]
	delete b.asked
	if (event.older === undefined) delete b.older
	else b.older = event.older
	return true
}

// Whether every page has been fetched.
function complete(all: Sessions, sessionId: string): boolean {
	let b = all.get(sessionId)
	return !b || (b.older === undefined && b.asked === undefined)
}

// `t` with the pages fetched so far in front.
function apply(all: Sessions, t: Transcript): Transcript {
	let b = all.get(t.meta.id)
	if (!b?.pages.length) return t
	// Stand-ins stay on top while pages further back remain; once all are
	// in (the terminal's one apply), no page need be compared with them.
	let keep = b.older !== undefined && !!b.earlier.length && !b.pages.some((r) => b.earlier.includes(JSON.stringify(r)))
	let out = transcript.prepend(t, b.loaded, b.pages, keep)
	b.loaded = [...b.pages, ...b.loaded]
	b.pages = []
	return out
}

// Background tabs are fetched nearest the shown one first. With no shown
// tab yet there is no first paint to protect, so wait for its snapshot.
function nearby(ids: string[], shown: string): string[] {
	let at = ids.indexOf(shown)
	if (at < 0) return []
	return ids.filter((id) => id !== shown).sort((a, b) => Math.abs(ids.indexOf(a) - at) - Math.abs(ids.indexOf(b) - at))
}

// The terminal's way: after a snapshot or a page, the command asking
// for the next page, and once the last is in, the transcript with all
// of them in front.
function fetchAll<V extends { transcript?: Transcript }>(all: Sessions, view: V, event: Event & { type: 'snapshot' | 'history' }): { command?: ReturnType<typeof next>; view?: Partial<V> } {
	if (event.type === 'snapshot') backfill.onSnapshot(all, event)
	else if (!backfill.onPage(all, event)) return {}
	let command = backfill.next(all, event.sessionId)
	let t = view.transcript
	if (command || event.type === 'snapshot' || t?.meta.id !== event.sessionId) return command ? { command } : {}
	return { view: { transcript: backfill.apply(all, t) } as Partial<V> }
}

export const backfill = { onSnapshot, next, onPage, complete, apply, fetchAll, nearby }
