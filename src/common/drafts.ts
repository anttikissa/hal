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
import type { Event } from './protocol.ts'

// `queue`: run after the current turn instead of steering it. `amend`:
// an edit of the last prompt (src/common/amend.ts).
export type Sending = { id: string; text: string; queue?: boolean; amend?: boolean }

export type Local = {
	// What the editor holds.
	text: string
	// The host's draft rev this text was edited from.
	base: number
	// Edited since the host last had it.
	dirty: boolean
	// Prompts sent and not acknowledged yet, oldest first.
	sending: Sending[]
}

export type Store = { load(sessionId: string): Local | undefined; save(sessionId: string, local: Local): void }

type DraftsState = {
	sessions: Map<string, Local>
	// The draft command in flight for each session: its id and text.
	inFlight: Map<string, Sending>
}

function createState(): DraftsState {
	return { sessions: new Map(), inFlight: new Map() }
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
	let sending = l.sending.filter((s) => s && typeof s.id === 'string' && typeof s.text === 'string' && (s.queue === undefined || typeof s.queue === 'boolean') && (s.amend === undefined || typeof s.amend === 'boolean'))
	return { text: l.text, base: l.base, dirty: l.dirty === true, sending }
}

function save(id: string): void {
	drafts.store.save(id, drafts.local(id))
}

function text(id: string): string {
	return drafts.local(id).text
}

// Prompts shown as pending (sent, not acknowledged).
function pending(id: string): string[] {
	return drafts.local(id).sending.map((s) => s.text)
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
function submit(id: string, text: string, queue = false, amend = false): void {
	let l = drafts.local(id)
	let sending: Sending = { id: drafts.nextId(), text }
	if (queue) sending.queue = true
	if (amend) sending.amend = true
	l.sending.push(sending)
	if (!l.text.trim() || text.includes(l.text.trim())) {
		l.text = ''
		// The host clears its draft when it takes the prompt.
		l.dirty = false
	}
	drafts.save(id)
	drafts.send(drafts.command(id, sending))
}

function command(sessionId: string, s: Sending): object {
	return { type: 'submit', sessionId, text: s.text, ...(s.queue ? { queue: true } : {}), ...(s.amend ? { amend: true } : {}), id: s.id }
}

// Folds a host event in. True if the session's editor text changed.
function onEvent(event: Event): boolean {
	let st = drafts.state
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
			if (event.type === 'rejected') {
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
