// A client's side of drafts and sending (tasks/j1/states.md, Drafts
// and sending), the same for the terminal and the browser. Typed text is
// never lost:
//
// - Every edit is saved locally at once (store: a file for the terminal,
//   localStorage for the browser) and sent to the host, which keeps one
//   draft per session for every client. One draft command is in flight
//   per session; edits made meanwhile go in the next one.
// - On (re)connecting, the snapshot's draft replaces the local one,
//   unless the local one was edited since the host last had it: then the
//   local one is sent (the host keeps both if both changed).
// - A sent prompt is pending until the host acknowledges its command id,
//   and kept in the store until then, so after a crash the next client
//   sends it again with the same id and the host never submits it twice.
//   Refused, it goes back into the editor.

import { connection } from './connection.ts'
import type { Delivery, Event } from './protocol.ts'
import type { QueueEditing } from './queue-edit.ts'
import { sendKeys } from './send-keys.ts'

// `queue`: run after the current turn instead of steering it. `amend`:
// an edit of the last message (src/common/amend.ts); `edits`: the id of
// the waiting inbox message it edits; `rewind`: the earlier prompt
// record it replaces, rewinding there (task 26q). `ts`: when it was
// sent, its time until the host's record replaces it (task ta).
// `base`: the draft rev the sent text emptied (host drafts.sent).
// `aside`: an edit was sent, not the draft, which stays.
export type Sending = {
	id: string
	text: string
	ts?: string
	delivery?: Delivery
	amend?: boolean
	edits?: string
	queueEdit?: string
	base?: number
	aside?: boolean
}

export type AmendSaved = {
	target?: string
	inbox?: string
	aside?: true
	paused?: boolean
	window?: string
}

export type Local = {
	// What the editor holds.
	text: string
	// The host's draft rev this text was edited from.
	base: number
	// Edited since the host last had it.
	dirty: boolean
	// Prompts sent and not acknowledged yet, oldest first.
	sending: Sending[]
	// Protected queue edit, separate from the shared draft.
	queueEdit?: QueueEditing
	// Unsent edits to earlier prompts (amend or recall), by slot key.
	edits?: Record<string, string>
	// Active amend session, restored on reload in the same window.
	amend?: AmendSaved
}

// `window`: names this window (queue-edit.ts), if the store is shared with others.
export type Store = {
	load(sessionId: string): Local | undefined
	save(sessionId: string, local: Local): void
	window?(): string
}

type DraftsState = {
	sessions: Map<string, Local>
	// The draft command in flight for each session: its id and text.
	inFlight: Map<string, Sending>
	window: string
}

function createState(): DraftsState {
	return { sessions: new Map(), inFlight: new Map(), window: crypto.randomUUID() }
}

function empty(): Local {
	return { text: '', base: 0, dirty: false, sending: [] }
}

// The session's local draft, from memory or the store.
function local(id: string): Local {
	let st = drafts.state
	let l = st.sessions.get(id)
	if (!l) {
		l = drafts.valid(drafts.store.load(id)) ?? drafts.empty()
		st.sessions.set(id, l)
	}
	return l
}

// Stored data comes from disk or localStorage: anything malformed reads
// as no draft rather than breaking the client.
function valid(l: Local | undefined): Local | undefined {
	if (!l || typeof l.text !== 'string' || typeof l.base !== 'number' || !Array.isArray(l.sending)) return undefined
	let sending = l.sending
		.filter(
			(s) =>
				s &&
				typeof s.id === 'string' &&
				typeof s.text === 'string' &&
				(s.ts === undefined || typeof s.ts === 'string') &&
				(s.delivery === undefined || !!sendKeys.parse(s.delivery)) &&
				(s.amend === undefined || typeof s.amend === 'boolean') &&
				(s.edits === undefined || typeof s.edits === 'string') &&
				(s.queueEdit === undefined || typeof s.queueEdit === 'string') &&
				(s.base === undefined || Number.isSafeInteger(s.base)) &&
				(s.aside === undefined || typeof s.aside === 'boolean'),
		)
		.map((s) => (s.delivery ? { ...s, delivery: sendKeys.parse(s.delivery)! } : s))
	let e = l.queueEdit
	let queueEdit =
		e &&
		typeof e.edit === 'string' &&
		typeof e.message === 'string' &&
		typeof e.text === 'string' &&
		typeof e.active === 'boolean' &&
		(e.original === undefined || typeof e.original === 'string') &&
		(e.request === undefined || typeof e.request === 'string') &&
		(e.saving === undefined || typeof e.saving === 'string') &&
		(e.window === undefined || typeof e.window === 'string')
			? e
			: undefined
	let edits: Record<string, string> | undefined
	if (l.edits && typeof l.edits === 'object' && !Array.isArray(l.edits)) {
		let out: Record<string, string> = {}
		for (let [k, v] of Object.entries(l.edits)) if (typeof v === 'string') out[k] = v
		if (Object.keys(out).length) edits = out
	}
	let a = l.amend
	let amend =
		a &&
		typeof a === 'object' &&
		!Array.isArray(a) &&
		(typeof a.target === 'string' || typeof a.inbox === 'string') &&
		(a.target === undefined || typeof a.target === 'string') &&
		(a.inbox === undefined || typeof a.inbox === 'string') &&
		(a.aside === undefined || a.aside === true) &&
		(a.paused === undefined || typeof a.paused === 'boolean') &&
		(a.window === undefined || typeof a.window === 'string')
			? a
			: undefined
	return {
		text: l.text,
		base: l.base,
		dirty: l.dirty === true,
		sending,
		...(queueEdit ? { queueEdit } : {}),
		...(edits ? { edits } : {}),
		...(amend ? { amend } : {}),
	}
}

function hasLocal(l: Local): boolean {
	return !!(l.text || l.sending.length || l.queueEdit || l.amend || (l.edits && Object.keys(l.edits).length))
}

function windowId(): string {
	return drafts.store.window?.() ?? drafts.state.window
}

function slot(id: string, key: string): string | undefined {
	return drafts.local(id).edits?.[key]
}

function saveSlot(id: string, key: string, text: string, original: string): void {
	let l = drafts.local(id)
	if (text === original) {
		if (!l.edits || !(key in l.edits)) return
		delete l.edits[key]
		if (!Object.keys(l.edits).length) delete l.edits
		drafts.save(id)
		return
	}
	if (l.edits?.[key] === text) return
	;(l.edits ??= {})[key] = text
	drafts.save(id)
}

function deleteSlot(id: string, key: string): void {
	let l = drafts.local(id)
	if (!l.edits || !(key in l.edits)) return
	delete l.edits[key]
	if (!Object.keys(l.edits).length) delete l.edits
	drafts.save(id)
}

function setAmend(id: string, a: Omit<AmendSaved, 'window'>): void {
	let l = drafts.local(id)
	let next: AmendSaved = {
		...(a.target !== undefined ? { target: a.target } : {}),
		...(a.inbox !== undefined ? { inbox: a.inbox } : {}),
		...(a.aside ? { aside: true } : {}),
		...(a.paused !== undefined ? { paused: a.paused } : {}),
		window: drafts.windowId(),
	}
	let cur = l.amend
	if (
		cur &&
		cur.target === next.target &&
		cur.inbox === next.inbox &&
		cur.aside === next.aside &&
		cur.paused === next.paused &&
		cur.window === next.window
	)
		return
	l.amend = next
	drafts.save(id)
}

function clearAmend(id: string): void {
	let l = drafts.local(id)
	if (!l.amend) return
	delete l.amend
	drafts.save(id)
}

function save(id: string): void {
	drafts.store.save(id, drafts.local(id))
}

function text(id: string): string {
	return drafts.local(id).text
}

// Prompts shown as pending (sent, not acknowledged); an /edit as the
// edited prompt it becomes.
function pending(id: string): Sending[] {
	return drafts
		.local(id)
		.sending.flatMap((s) => (s.queueEdit === undefined ? [{ ...s, text: s.text.replace(/^\/edit \d+\n/, '') }] : []))
}

// The user changed the editor text.
function edit(id: string, text: string): void {
	let l = drafts.local(id)
	if (l.text === text) return
	l.text = text
	l.dirty = true
	drafts.save(id)
	drafts.flush(id)
}

// Adds `early`, text typed before the session was shown, to its draft.
function join(id: string, early: string): void {
	if (early) drafts.edit(id, drafts.text(id) ? `${drafts.text(id)}\n${early}` : early)
}

// Sends the local draft if the host lacks it and none is in flight.
function flush(id: string): void {
	let l = drafts.local(id)
	if (!l.dirty || drafts.state.inFlight.has(id)) return
	let command = { type: 'draft', sessionId: id, text: l.text, base: l.base, id: drafts.nextId() }
	drafts.state.inFlight.set(id, { id: command.id, text: l.text })
	drafts.send(command)
}

// Sends `text` as a prompt, pending. The draft empties if it was what
// was sent; a draft that holds more (an entry recalled from history was
// sent, not the draft) stays, as the host keeps it too.
function submit(id: string, text: string, how: Omit<Sending, 'id' | 'text'> & { id?: string } = {}): void {
	let l = drafts.local(id)
	let sending: Sending = { id: how.id ?? drafts.nextId(), text, ts: new Date().toISOString() }
	if (how.delivery && how.delivery !== 'steer') sending.delivery = how.delivery
	if (how.amend) sending.amend = true
	if (how.edits !== undefined) sending.edits = how.edits
	if (how.queueEdit !== undefined) sending.queueEdit = how.queueEdit
	if (how.aside) sending.aside = true
	l.sending.push(sending)
	if (!how.queueEdit) {
		delete l.edits
		delete l.amend
	}
	if (!how.queueEdit && !how.aside && (!l.text.trim() || text.includes(l.text.trim()))) {
		if (l.text.trim()) sending.base = l.base
		l.text = ''
		// The host clears its draft when it takes the prompt.
		l.dirty = false
	}
	drafts.save(id)
	drafts.send(drafts.command(id, sending))
}

function command(sessionId: string, s: Sending): object {
	return {
		type: 'submit',
		sessionId,
		text: s.text,
		...(s.queueEdit === undefined ? {} : { queueEdit: s.queueEdit }),
		...(s.delivery ? { delivery: s.delivery } : {}),
		...(s.amend ? { amend: true } : {}),
		...(s.edits === undefined ? {} : { edits: s.edits }),
		...(s.base === undefined ? {} : { base: s.base }),
		...(s.aside ? { aside: true } : {}),
		id: s.id,
	}
}

// Folds a host event in. True if the session's editor text changed.
function onEvent(event: Event): boolean {
	let st = drafts.state
	// The host's copy of a sent prompt (history or the inbox, under the
	// id it was sent with) replaces the local one at once, not at the
	// ack after it: a frame between them would draw the prompt twice.
	let taken =
		event.type === 'inbox'
			? event.inbox.map((m) => m.id)
			: (event.type === 'prompt' || event.type === 'turn-start' || event.type === 'command') && event.command
				? [event.command]
				: []
	if (taken.length && 'sessionId' in event && event.sessionId) {
		let id = event.sessionId
		let l = st.sessions.get(id)
		if (l?.sending.some((s) => taken.includes(s.id))) {
			l.sending = l.sending.filter((s) => !taken.includes(s.id))
			drafts.save(id)
		}
		return false
	}
	if (event.type === 'snapshot') {
		let id = event.sessionId
		let l = drafts.local(id)
		let before = l.text
		// A draft still in flight is resent by the connection; one it
		// forgot (a new start) is superseded by the flush below.
		let mine = st.inFlight.get(id)
		if (mine && !drafts.inConnection(mine.id)) st.inFlight.delete(id)
		let host = event.snapshot.draft ?? { text: '', rev: 0 }
		if (!l.dirty) {
			l.text = host.text
			l.base = host.rev
		}
		drafts.save(id)
		// Prompts a crashed client left unacknowledged, again with their
		// ids: the host acts on each at most once.
		for (let s of l.sending) if (!drafts.inConnection(s.id)) drafts.send(drafts.command(id, s))
		drafts.flush(id)
		return l.text !== before
	}
	if (event.type === 'draft') {
		let id = event.sessionId
		let l = drafts.local(id)
		let before = l.text
		let mine = st.inFlight.get(id)
		if (mine && event.command === mine.id) {
			// Our edit landed (maybe merged with another client's).
			if (l.text === mine.text) {
				l.text = event.draft.text
				l.dirty = false
				l.base = event.draft.rev
			} else if (event.draft.text === mine.text) l.base = event.draft.rev
		} else if (!l.dirty) {
			l.text = event.draft.text
			l.base = event.draft.rev
		}
		drafts.save(id)
		return l.text !== before
	}
	if (event.type === 'ack' || event.type === 'rejected') {
		if (event.id === undefined) return false
		for (let [id, sent] of st.inFlight) {
			if (sent.id !== event.id) continue
			st.inFlight.delete(id)
			// A refused one is not retried: it would be refused again.
			if (event.type === 'ack') drafts.flush(id)
			return false
		}
		for (let [id, l] of st.sessions) {
			let i = l.sending.findIndex((s) => s.id === event.id)
			if (i < 0) continue
			let [s] = l.sending.splice(i, 1)
			// A refused prompt goes back into the editor, before anything
			// typed since.
			if (event.type === 'rejected' && s!.queueEdit === undefined) {
				l.text = l.text ? `${s!.text}\n${l.text}` : s!.text
				l.dirty = true
			}
			drafts.save(id)
			drafts.flush(id)
			return event.type === 'rejected'
		}
	}
	return false
}

function reset(): void {
	drafts.state = createState()
}

export const drafts = {
	state: createState(),
	// Where local copies live; the terminal and the page replace this.
	store: { load: () => undefined, save: () => {} } as Store,
	send: (command: object): void => connection.send(command),
	nextId: (): string => connection.nextId(),
	// Whether the connection still holds the command with this id.
	inConnection: (id: string): boolean => connection.state.pending.has(id),
	empty,
	local,
	valid,
	hasLocal,
	windowId,
	slot,
	saveSlot,
	deleteSlot,
	setAmend,
	clearAmend,
	save,
	text,
	pending,
	edit,
	join,
	flush,
	submit,
	command,
	onEvent,
	reset,
}
