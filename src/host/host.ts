// Host protocol: durable history before live events, shared by all transports.
// Sliced snapshots hold commands until sent, then run them in order (task 7j).

import { ason } from '../common/ason.ts'
import { protocol, type Command, type Event } from '../common/protocol.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { commands } from './commands.ts'
import { clients, type ClientInfo, type ClientRecord } from './clients.ts'
import { blobs } from './blobs.ts'
import { clock } from './clock.ts'
import { config } from './config.ts'
import { find } from './find.ts'
import { busy } from './busy.ts'
import { drafts } from './drafts.ts'
import { history } from './history.ts'
import { greetings } from './greetings.ts'
import { jobs } from './jobs.ts'
import { pages, type Page, type Tail } from './pages.ts'
import { notify } from './notify.ts'
import { noticeHistory } from './notice-history.ts'
import { push } from './push.ts'
import { sessions } from './sessions.ts'
import { snapshots } from './snapshots.ts'
import { prompts } from './prompts.ts'
import { slash } from './slash.ts'
import { stats } from './stats.ts'
import { version } from './version.ts'
import { status } from './status.ts'
import { tabs } from './tabs.ts'
import { turns } from './turns.ts'
import { webAuth } from './web-auth.ts'
import { webLinks } from './web-links.ts'
import { wire } from './wire.ts'
import { rebaseRows } from '../common/rebase-rows.ts'
import { rebasePlans } from './rebase-plans.ts'
import { recap } from './recap.ts'

export type Connection = {
	// Takes unvalidated data: the peer may be another process.
	send(command: unknown): void
	close(): void
}

// `held`: commands waiting, by session, for its snapshot to be sent;
// under '*', every command, until the tabs are sent.
type Client = { deliver: (event: Event) => void; open: Set<string>; visible?: string; shown?: string; visibleAt?: number; held: Map<string, unknown[]>; record: ClientRecord }
// What a command did: refused (why), or done, naming a created session
// (followed) or the tab a tab command created, reopened or picked, or
// with the event that answered it (attached), sent again on a repeat.
type Outcome = { refused?: string; sessionId?: string; tab?: string; reply?: Event }

function connect(deliver: (event: Event) => void, info?: ClientInfo): Connection {
	let open = new Set<string>()
	let client: Client = { deliver: (e) => deliver(wire.event(e)), open, held: new Map(), record: clients.join(open, info) }
	host.state.clients.add(client)
	host.warn(client)
	if (version.state.loaded) client.deliver({ type: 'version', version: version.state.loaded })
	// The tabs come with the first events, so no client has to ask; their
	// states need the open tabs' marks, caught up in slices first.
	let indexed = tabs.indexed()
	if (!indexed) tabs.greet(client, () => host.state.clients.has(client))
	else {
		client.held.set('*', [])
		void indexed.then(() => host.state.clients.has(client) && host.release(client, '*'))
	}
	return {
		send: (command) => {
			if (host.state.clients.has(client)) host.handle(client, wire.copy(command))
		},
		close: () => {
			host.state.clients.delete(client)
			if (client.visible) void recap.prepare(client.visible)
			clients.leave(client.record)
			webLinks.drop(client)
			find.cancel(client)
		},
	}
}

// Carries out the commands held under `key` (a session, or '*' for the
// tabs), in order; handle() holds them again if need be.
function release(client: Client, key: string): void {
	let held = client.held.get(key) ?? []
	client.held.delete(key)
	if (key === '*') tabs.greet(client, () => host.state.clients.has(client))
	for (let c of held) host.handle(client, c)
}

// One transport connection (a socket, a WebSocket) as a host
// connection: each message received is one ASON command, and each event
// goes to `write` as one short ASON message. Unreadable messages are
// answered with `rejected`, never thrown.
function adapt(write: (message: string) => void, info?: ClientInfo): { receive(message: string): void; unreadable(reason: string): void; close(): void } {
	let send = (event: Event) => write(ason.stringify(event, 'short'))
	let conn = host.connect(send, info)
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

// This process's version is known: every client hears it (task n1).
function announce(loaded: string): void {
	for (let client of host.state.clients) client.deliver({ type: 'version', version: loaded })
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
const once = new Set(['rebase-apply', 'rebase-error', 'create', 'submit', 'draft', 'pause', 'continue', 'answer', 'attach', 'tab-new', 'tab-close', 'tab-resume', 'tab-move', 'tab-start'])

// Records what a command with an id did, forgetting the oldest beyond
// host.remembered.
function remember(id: string, outcome: Outcome): void {
	let done = host.state.done
	done.set(id, outcome)
	for (let old of done.keys()) {
		if (done.size <= host.remembered) break
		done.delete(old)
	}
}

function handle(client: Client, command: unknown): void {
	clients.touch(client.record)
	let held = client.held.get('*') ?? client.held.get((command as { sessionId?: string } | null)?.sessionId as string)
	if (held) return void held.push(command)
	let problem = protocol.invalid(command)
	if (problem) return host.reject(client, command, problem, (command as any)?.sessionId)
	let c = command as Command
	let repeat = c.id === undefined ? undefined : (host.state.done.get(c.id) ?? host.submitted(c))
	if (repeat) return host.answer(client, c, repeat)
	let outcome: Outcome | Promise<Outcome> | undefined
	try {
		outcome = host.act(client, c)
	} catch (e: any) {
		outcome = { refused: String(e?.message ?? e) }
	}
	// Undefined: act() answers when it is done.
	if (!outcome) return
	let done = (outcome: Outcome) => {
		if (c.id !== undefined && once.has(c.type)) host.remember(c.id, outcome)
		host.answer(client, c, outcome, false)
	}
	if (!(outcome instanceof Promise)) return done(outcome)
	void outcome
		.catch((e) => ({ refused: String(e?.message ?? e) }))
		.then((o) => {
			if (!host.state.clients.has(client)) return
			done(o)
			if (c.type === 'open') host.release(client, c.sessionId)
		})
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

// Carries out a valid command: what it did (a promise if that takes
// slices), or undefined if it will answer later.
function act(client: Client, c: Command): Outcome | Promise<Outcome> | undefined {
	clients.input(client.record, c)
	if (c.type === 'find') { find.search(client, c.request, c.query, c.kinds, client.deliver); return {} }
	if (c.type === 'find-cancel') { find.cancel(client); return {} }
	if (c.type === 'create' || c.type === 'open-newest') {
		let id = c.type === 'open-newest' ? sessions.newest() : undefined
		if (id) return host.act(client, { type: 'open', sessionId: id, ...(c.id === undefined ? {} : { id: c.id }) })
		id = sessions.create(c.type === 'create' ? c : { cwd: c.cwd ?? host.cwd() }).id
		greetings.open(id)
		host.follow(client, id)
		return { sessionId: id }
	}
	if (c.type === 'open') {
		let id = c.sessionId
		let ready = host.ready(id)
		let tail = ready ? undefined : pages.slices(pages.snapshotSteps(id))
		if (tail && !(tail instanceof Promise)) {
			host.follow(client, id, tail)
			return {}
		}
		client.held.set(id, [])
		return (async () => {
			await ready
			host.follow(client, id, await (tail ?? pages.slices(pages.snapshotSteps(id))))
			return {}
		})()
	}
	if (tabs.is(c)) return tabs.act(c)
	if (c.type === 'auth' && c.link) webLinks.follow(client, client.deliver)
	if (c.type === 'push-subscribe' || c.type === 'push') return push.command(c).then((reply) => ({ reply }))
	if (c.type === 'notice-history') return { reply: { type: 'notice-history', entries: noticeHistory.list() } }
	if (c.type === 'hello' || c.type === 'screen') return c.type === 'hello' ? clients.hello(client.record, c.pid) : clients.screen(client.record, c)
	if (c.type === 'visibility') {
		// A known tab may still be waiting for its open snapshot.
		if (!client.open.has(c.sessionId) && !tabs.file().open.includes(c.sessionId)) return { refused: 'visibility: session is not an open tab or followed session' }
		let previous = client.visible
		client.visible = c.visible ? c.sessionId : undefined; client.shown = c.sessionId; client.visibleAt = Date.now()
		recap.visibility(previous, client.visible)
		return {}
	}
	if (c.type === 'auth') return c.link ? {} : { reply: { type: 'auth', code: webAuth.issue() } }
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
	if (c.type === 'close') { client.open.delete(c.sessionId); if (client.visible === c.sessionId) client.visible = undefined; if (client.shown === c.sessionId) client.shown = undefined }
	else if (c.type === 'attach') {
		let stored = c.name !== undefined ? blobs.stage(c.name, c.mediaType, c.data) : blobs.store(c.sessionId, c.mediaType, c.data)
		return { reply: { type: 'attached', sessionId: c.sessionId, command: c.id ?? '', blob: stored.blob, marker: stored.marker } }
	} else if (c.type === 'rebase-error') slash.output(c.sessionId, c.text, true)
	else if (c.type === 'rebase-apply') return { reply: rebasePlans.answer(c) }
	else if (c.type === 'submit') {
		let unknown = commands.parse(c.text) ? [] : blobs.unknown(c.sessionId, c.text)
		if (unknown.length) client.deliver({ type: 'warning', text: `${unknown.join(', ')} names no attachment of this session; sent as text` })
		let amending = c.amend && !c.queue && !commands.parse(c.text)
		if (c.amend && !c.queue && c.edits !== undefined) refused = prompts.edit(c.sessionId, c.edits, c.text, c.id)
		else if (commands.parse(c.text)?.name === 'rebase') refused = slash.command(c.sessionId, c.text, commands.parse(c.text)!, c.id, undefined, (reply) => { if (reply.rebase) client.deliver({ type: 'rebase-plan', sessionId: c.sessionId, snapshot: reply.rebase, todo: rebaseRows.render(c.sessionId, reply.rebase) }) })
		else refused = amending ? prompts.amend(c.sessionId, c.text, c.id) : prompts.submit(c.sessionId, c.text, c.id, c.queue)
		if (refused === undefined) prompts.sent(c.sessionId, c.text, c.id)
	} else if (c.type === 'draft') {
		let changed = drafts.set(c.sessionId, c.text, c.base)
		if (changed) prompts.draft(c.sessionId, changed, c.id)
		else return { reply: { type: 'draft', sessionId: c.sessionId, draft: drafts.get(c.sessionId), ...(c.id !== undefined ? { command: c.id } : {}) } }
	} else if (c.type === 'continue') refused = prompts.resume(c.sessionId)
	else if (c.type === 'pause') refused = turns.stop(c.sessionId)
	else if (c.type === 'answer') refused = prompts.reply(c.sessionId, c.question, c.answers)
	else if (c.type === 'models') void slash.models(c.sessionId).then((e) => host.state.clients.has(client) && client.deliver(e))
	else if (c.type === 'history') {
		let answer = (page: Page): Outcome => {
			let reply: Event = { type: 'history', sessionId: c.sessionId, before: c.before, records: page.records }
			if (page.start > 0 && !page.records.some((r) => r.type === 'reset')) reply.older = page.start // nothing before a /clear (vh)
			return { reply }
		}
		let page = pages.slices(pages.pageSteps(c.sessionId, c.before))
		return page instanceof Promise ? page.then(answer) : answer(page)
	} else if (c.type === 'complete') client.deliver({ type: 'completions', sessionId: c.sessionId, text: c.text, ...commands.suggestions(c.text, slash.context(c.sessionId)) })
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

// Sends the session's snapshot and from then on its events. A tail read
// in slices is caught up with what was appended meanwhile.
function follow(client: Client, id: string, tail?: Tail): void {
	if (!host.state.clients.has(client)) return
	client.open.add(id)
	client.deliver({ type: 'snapshot', sessionId: id, snapshot: snapshots.build(id, tail && pages.since(id, tail)) })
}

function broadcast(id: string, event: Event): void {
	for (let client of host.state.clients) if (client.open.has(id)) client.deliver(event)
	tabs.observe(id, event)
	if (event.type === 'turn-end') void recap.prepare(id)
	notify.route(host.state.clients, id, event)
}

// Whenever this process exits while it is host (quit, restart, SIGTERM,
// SIGHUP), writes the output of running turns so far and aborts them,
// which kills their bash process groups, and kills background commands
// (jobs.ts): no command outlives the Hal that ran it. The turns stay unfinished for the next host to continue
// as interrupted; or, if the user quit the last Hal process
// (quitting()), they are recorded paused. Idempotent.
function init(): void {
	if (host.state.inited) return
	host.state.inited = true
	process.on('exit', () => {
		history.stop(host.state.pauseOnExit)
		for (let r of turns.state.running.values()) r.controller.abort()
		jobs.killAll()
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
	history.stop(false)
	find.reset()
	recap.reset()
	for (let r of turns.state.running.values()) r.controller.abort()
	turns.state.running.clear()
	jobs.killAll()
	host.state.opening.clear()
	host.state.clients.clear()
	status.state.states.clear()
	status.state.derived.clear()
	for (let map of Object.values(stats.state)) map.clear()
	pages.reset()
	for (let map of [history.state.cache, history.state.next]) map.clear()
	host.state.done.clear()
	tabs.reset()
	push.reset()
	noticeHistory.reset()
	busy.reset()
	drafts.reset()
	webLinks.reset()
	clients.reset()
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
	remembered: 1000,
	connect,
	adapt,
	warn,
	warnAll,
	announce,
	reject,
	remember,
	handle,
	submitted,
	answer,
	act,
	ready,
	follow,
	release,
	broadcast,
	init,
	quitting,
	reset,
}
