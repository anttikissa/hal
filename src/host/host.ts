// The host end of the protocol (src/common/protocol.ts). It alone owns
// sessions, provider calls and state writes; clients only send commands
// and receive events. connect() is the in-memory connection; a socket
// transport wraps it by serializing both directions. Commands are
// carried out by the session modules: prompts.ts (what the user sends),
// turns.ts (running a turn), slash.ts (slash commands), status.ts (the
// session's state).
//
// Snapshot and live events are sent from the same synchronous step, so a
// client that opens a session never misses or double-counts an event.
// The conversation lives only in durable history (history.ts): prompts,
// finished blocks, tool results and turn ends are on disk before clients
// hear of them, and snapshots and provider input are read back from
// there.

import { ason } from '../common/ason.ts'
import { protocol, type Command, type Event, type Snapshot } from '../common/protocol.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { commands } from './commands.ts'
import { blobs } from './blobs.ts'
import { clock } from './clock.ts'
import { config } from './config.ts'
import { diag } from './diag.ts'
import { busy } from './busy.ts'
import { drafts } from './drafts.ts'
import { history } from './history.ts'
import { pages } from './pages.ts'
import { sessions } from './sessions.ts'
import { prompts } from './prompts.ts'
import { slash } from './slash.ts'
import { status } from './status.ts'
import { tabs } from './tabs.ts'
import { turns } from './turns.ts'

export type Connection = {
	// Takes unvalidated data: the peer may be another process.
	send(command: unknown): void
	close(): void
}

type Client = { deliver: (event: Event) => void; open: Set<string> }
// What a command did: refused (why), or done, naming a created session
// (followed) or the tab a tab command created, reopened or picked, or
// with the event that answered it (attached), sent again on a repeat.
type Outcome = { refused?: string; sessionId?: string; tab?: string; reply?: Event }

// The in-memory stand-in for the wire: both directions go through ASON,
// so nothing non-serializable or shared by reference crosses it.
function wire<T>(value: T): T {
	return ason.parse(ason.stringify(value, 'short')) as T
}

function connect(deliver: (event: Event) => void): Connection {
	let client: Client = { deliver: (e) => deliver(wire(e)), open: new Set() }
	host.state.clients.add(client)
	host.warn(client)
	// The tabs come with the first events, so no client has to ask.
	try {
		client.deliver({ type: 'tabs', tabs: tabs.list() })
	} catch (e: any) {
		client.deliver({ type: 'warning', text: String(e?.message ?? e) })
	}
	return {
		send: (command) => {
			if (host.state.clients.has(client)) host.handle(client, wire(command))
		},
		close: () => {
			host.state.clients.delete(client)
		},
	}
}

// One transport connection (a socket, a WebSocket) as a host
// connection: each message received is one ASON command, and each event
// goes to `write` as one short ASON message. Unreadable messages are
// answered with `rejected`, never thrown.
function adapt(write: (message: string) => void): { receive(message: string): void; unreadable(reason: string): void; close(): void } {
	let send = (event: Event) => write(ason.stringify(event, 'short'))
	let conn = host.connect(send)
	let unreadable = (reason: string) => send({ type: 'rejected', command: '', reason: `unreadable message: ${reason}` })
	return {
		receive: (message) => {
			let command: unknown
			try {
				command = ason.parse(message)
			} catch (e: any) {
				return unreadable(String(e?.message ?? e))
			}
			conn.send(command)
		},
		unreadable,
		close: () => conn.close(),
	}
}

// Tells a client what is wrong with config.ason, if anything.
function warn(client: Client): void {
	let text = config.warnings().join('; ')
	if (text) client.deliver({ type: 'warning', text })
}

// After config.ason changed: tells every client what is wrong now.
function warnAll(): void {
	for (let client of host.state.clients) host.warn(client)
}

function reject(client: Client, command: unknown, reason: string, sessionId?: unknown): void {
	let c = command as { type?: unknown; id?: unknown } | null
	let type = c?.type
	let event: Event = { type: 'rejected', command: typeof type === 'string' ? type : String(type), reason }
	if (typeof sessionId === 'string') event.sessionId = sessionId
	if (typeof c?.id === 'string') event.id = c.id
	client.deliver(event)
}

// Commands whose effect outlives the connection. A repeat of one of
// these ids is answered as before and not carried out again. Opening
// and closing are per connection, so a repeat always acts.
const once = new Set(['create', 'submit', 'draft', 'pause', 'continue', 'answer', 'attach', 'tab-new', 'tab-close', 'tab-resume', 'tab-move', 'tab-start'])

// Records what a command with an id did, forgetting the oldest beyond
// host.remembered().
function remember(id: string, outcome: Outcome): void {
	let done = host.state.done
	done.set(id, outcome)
	for (let old of done.keys()) {
		if (done.size <= host.remembered()) break
		done.delete(old)
	}
}

function handle(client: Client, command: unknown): void {
	let problem = protocol.invalid(command)
	if (problem) return host.reject(client, command, problem, (command as any)?.sessionId)
	let c = command as Command
	let repeat = c.id === undefined ? undefined : (host.state.done.get(c.id) ?? host.submitted(c))
	if (repeat) return host.answer(client, c, repeat)
	let outcome: Outcome | undefined
	try {
		outcome = host.act(client, c)
	} catch (e: any) {
		outcome = { refused: String(e?.message ?? e) }
	}
	// Undefined: still opening; act() answers when it is done.
	if (!outcome) return
	if (c.id !== undefined && once.has(c.type)) host.remember(c.id, outcome)
	host.answer(client, c, outcome, false)
}

// A repeat of a submit the previous host recorded, found in history.
function submitted(c: Command): Outcome | undefined {
	if (c.type !== 'submit' || !sessions.state.open.has(c.sessionId)) return undefined
	let seen = (r: HistoryRecord) => ((r.type === 'user' || r.type === 'command') && r.command === c.id) || (r.type === 'inbox' && (r.id === c.id || r.command === c.id))
	return history.readSync(c.sessionId).some(seen) ? {} : undefined
}

// Acknowledges or rejects a command. A repeated create follows its
// session again, so the resender sees it too.
function answer(client: Client, c: Command, outcome: Outcome, repeat = true): void {
	let sessionId = 'sessionId' in c ? c.sessionId : outcome.sessionId
	if (outcome.refused !== undefined) return host.reject(client, c, outcome.refused, sessionId)
	if (repeat && outcome.sessionId) host.follow(client, outcome.sessionId)
	if (outcome.reply) client.deliver(outcome.reply)
	if (c.id !== undefined) client.deliver({ type: 'ack', id: c.id, ...(outcome.tab ? { tab: outcome.tab } : {}) })
}

// Carries out a valid command: what it did, or undefined if it will
// answer later.
function act(client: Client, c: Command): Outcome | undefined {
	if (c.type === 'create' || c.type === 'open-newest') {
		let id = c.type === 'open-newest' ? sessions.newest() : undefined
		if (id) return host.act(client, { type: 'open', sessionId: id, ...(c.id === undefined ? {} : { id: c.id }) })
		let init: { cwd: string; model?: string; name?: string } = { cwd: c.cwd ?? host.cwd() }
		if (c.type === 'create' && c.model !== undefined) init.model = c.model
		if (c.type === 'create' && c.name !== undefined) init.name = c.name
		id = sessions.create(init).id
		host.follow(client, id)
		return { sessionId: id }
	}
	if (c.type === 'open') {
		let ready = host.ready(c.sessionId)
		if (!ready) {
			host.follow(client, c.sessionId)
			return {}
		}
		// Once open, the same command takes the synchronous path.
		ready.then(
			() => host.state.clients.has(client) && host.handle(client, c),
			(e) => host.reject(client, c, String(e?.message ?? e), c.sessionId),
		)
		return undefined
	}
	if (tabs.is(c)) return tabs.act(c)
	if (!client.open.has(c.sessionId)) return { refused: 'session is not open on this connection' }
	// An edit waits for the turn it paused to finish stopping, so nothing
	// that turn still records lands after the edit.
	// It goes through handle() again, so a resend that arrived meanwhile,
	// deferred behind it on the same promise, is then seen as a repeat.
	let stopping = c.type === 'submit' && c.amend && status.stateOf(c.sessionId).type === 'paused' && turns.state.running.get(c.sessionId)?.done
	if (stopping) {
		stopping.then(() => host.state.clients.has(client) && host.handle(client, c))
		return undefined
	}
	let refused: string | undefined
	if (c.type === 'close') client.open.delete(c.sessionId)
	else if (c.type === 'attach') {
		let stored = blobs.store(c.sessionId, c.mediaType, c.data)
		return { reply: { type: 'attached', sessionId: c.sessionId, command: c.id ?? '', blob: stored.blob, marker: stored.marker } }
	} else if (c.type === 'submit') {
		let unknown = commands.parse(c.text) ? [] : blobs.unknown(c.sessionId, c.text)
		if (unknown.length) client.deliver({ type: 'warning', text: `${unknown.join(', ')} names no attachment of this session; sent as text` })
		// A slash command runs even when typed while editing a prompt.
		// An edit of a waiting message may become one too (prompts.edit).
		let amending = c.amend && !c.queue && !commands.parse(c.text)
		if (c.amend && !c.queue && c.edits !== undefined) refused = prompts.edit(c.sessionId, c.edits, c.text, c.id)
		else refused = amending ? prompts.amend(c.sessionId, c.text, c.id) : prompts.submit(c.sessionId, c.text, c.id, c.queue)
		if (refused === undefined) prompts.sent(c.sessionId, c.text, c.id)
	} else if (c.type === 'draft') prompts.draft(c.sessionId, drafts.set(c.sessionId, c.text, c.base), c.id)
	else if (c.type === 'continue') refused = prompts.resume(c.sessionId)
	else if (c.type === 'pause') refused = turns.stop(c.sessionId)
	else if (c.type === 'answer') refused = prompts.reply(c.sessionId, c.question, c.answers)
	else if (c.type === 'models') void slash.models(c.sessionId).then((e) => host.state.clients.has(client) && client.deliver(e))
	else if (c.type === 'history') {
		let page = pages.page(c.sessionId, c.before)
		let reply: Event = { type: 'history', sessionId: c.sessionId, before: c.before, records: page.records }
		if (page.start > 0) reply.older = page.start
		return { reply }
	} else if (c.type === 'complete') client.deliver({ type: 'completions', sessionId: c.sessionId, text: c.text, items: commands.complete(c.text, slash.context(c.sessionId)) })
	return refused === undefined ? {} : { refused }
}

// Undefined if the session is open and its history repaired; otherwise
// opens it (history.open), once however many clients ask meanwhile.
function ready(id: string): Promise<void> | undefined {
	let pending = host.state.opening.get(id)
	if (pending) return pending
	if (sessions.state.open.has(id)) return undefined
	pending = history
		.open(id)
		.then(() => {})
		.finally(() => host.state.opening.delete(id))
	host.state.opening.set(id, pending)
	return pending
}

function follow(client: Client, id: string): void {
	client.open.add(id)
	client.deliver({ type: 'snapshot', sessionId: id, snapshot: host.snapshot(id) })
}

function snapshot(id: string): Snapshot {
	let tail = pages.snapshot(id)
	let records = [...tail.earlier, ...tail.history]
	let snap: Snapshot = { meta: { ...sessions.open(id) }, history: tail.history, state: status.stateOf(id, records), inbox: status.inboxOf(id, records) }
	if (tail.older !== undefined) Object.assign(snap, { older: tail.older, earlier: tail.earlier })
	try {
		let draft = drafts.get(id)
		if (draft.rev) snap.draft = draft
	} catch (e: any) {
		// A malformed draft.ason stays on disk untouched; the session opens.
		diag.log(`draft ${id}: ${e?.message ?? e}`)
	}
	let running = turns.state.running.get(id)
	if (running) {
		let live = history.live(id)
		snap.turn = { provider: running.provider, blocks: live?.blocks ?? [], usage: live?.usage ?? {}, ns: live?.ns ?? [] }
	}
	return snap
}

function broadcast(id: string, event: Event): void {
	for (let client of host.state.clients) if (client.open.has(id)) client.deliver(event)
	tabs.observe(id, event)
}

// Whenever this process exits while it is host, writes the output of
// running turns so far and leaves them unfinished, for the next host to
// continue; or, if the user quit the last Hal process (quitting()),
// records them paused and stops their tools (a running bash is killed).
// Idempotent.
function init(): void {
	if (host.state.inited) return
	host.state.inited = true
	process.on('exit', () => {
		history.stop(host.state.pauseOnExit)
		if (host.state.pauseOnExit) for (let r of turns.state.running.values()) r.controller.abort()
	})
	clock.init()
}

// The user is quitting this process. If no other Hal process can carry
// on (`last`), running turns are recorded paused as it exits: a runaway
// must stop and stay stopped until the user has looked at it.
function quitting(last: boolean): void {
	host.state.pauseOnExit = last
}

// Forgets every client and turn (tests).
function reset(): void {
	for (let r of turns.state.running.values()) r.controller.abort()
	turns.state.running.clear()
	host.state.opening.clear()
	host.state.clients.clear()
	status.state.states.clear()
	pages.reset()
	host.state.done.clear()
	tabs.reset()
	busy.reset()
	drafts.reset()
	host.state.pauseOnExit = false
}

export const host = {
	state: {
		clients: new Set<Client>(),
		// Sessions being opened from disk (history.open).
		opening: new Map<string, Promise<void>>(),
		// What each recent command id did, oldest first.
		done: new Map<string, Outcome>(),
		pauseOnExit: false,
		inited: false,
	},
	// Working directory for a session created without one.
	cwd: (): string => process.cwd(),
	// How many command ids the host remembers for spotting repeats.
	remembered: () => 1000,
	wire,
	connect,
	adapt,
	warn,
	warnAll,
	reject,
	remember,
	handle,
	submitted,
	answer,
	act,
	ready,
	follow,
	snapshot,
	broadcast,
	init,
	quitting,
	reset,
}
