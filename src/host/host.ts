// The host protocol, which every transport shares: clients send commands
// and get events. Durable history is written before live events go out.
// While a snapshot is sent in slices, the connection's commands wait,
// then run in order (task 7j).

import { type Command, type Event } from '../common/protocol.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { clients, type ClientInfo, type ClientRecord } from './clients.ts'
import { clock } from './clock.ts'
import { find } from './find.ts'
import { busy } from './busy.ts'
import { drafts } from './drafts.ts'
import { history } from './history.ts'
import { greetings } from './greetings.ts'
import { jobs } from './jobs.ts'
import { work } from './work.ts'
import { pages, type Tail } from './pages.ts'
import { notify } from './notify.ts'
import { noticeHistory } from './notice-history.ts'
import { pluginSync } from './plugin-sync.ts'
import { push } from './push.ts'
import { sessions } from './sessions.ts'
import { snapshots } from './snapshots.ts'
import { sessionCommands } from './session-commands.ts'
import { stats } from './stats.ts'
import { version } from './version.ts'
import { status } from './status.ts'
import { tabs } from './tabs.ts'
import { tools } from './tools.ts'
import { turns } from './turns.ts'
import { webAuth } from './web-auth.ts'
import { webLinks } from './web-links.ts'
import { serverLog } from './server-log.ts'
import { handover } from './commands/restart.ts'
import { warnings } from './warnings.ts'
import { wire } from './wire.ts'
import { queueEdits } from './queue-edits.ts'
import { recap } from './recap.ts'
import { promptCache } from './prompt-cache.ts'
import { settings } from '../common/settings.ts'
import { webDiagnostics } from './web-diagnostics.ts'
import { diag } from './diag.ts'
import { usage } from './usage.ts'
import { commandCheck } from '../common/command-check.ts'
import { userQuit } from '../common/user-quit.ts'
import { server } from './server.ts'

export type Connection = {
	// Takes unvalidated data: the peer may be another process.
	send(command: unknown): void
	close(): void
}

// `held`: commands waiting, by session, for its snapshot to be sent;
// under '*', every command, until the tabs are sent.
export type Client = {
	deliver: (event: Event) => void
	open: Set<string>
	visible?: string
	shown?: string
	visibleAt?: number
	held: Map<string, unknown[]>
	record: ClientRecord
}
// What a command did: refused (why), or done, naming a created session
// (followed) or the tab a tab command created, reopened or picked, or
// with the event that answered it (attached), sent again on a repeat.
export type Outcome = { refused?: string; sessionId?: string; tab?: string; reply?: Event }

function connect(deliver: (event: Event) => void, info?: ClientInfo): Connection {
	let open = new Set<string>()
	let client: Client = {
		deliver: (e) => deliver(wire.event(e)),
		open,
		held: new Map(),
		record: clients.join(open, info),
	}
	host.state.clients.add(client)
	serverLog.joined(client.record)
	warnings.send(client)
	if (version.state.loaded) client.deliver({ type: 'version', version: version.state.loaded })
	if (process.env.HOME) client.deliver({ type: 'home', path: process.env.HOME })
	client.deliver({ type: 'host-mode', noUser: promptCache.state.noUser })
	// The tabs come with the first events, so no client has to ask; their
	// states need the open tabs' marks, caught up in slices first. Held
	// commands run a turn of the event loop after the tabs (task 7j).
	let indexed = tabs.indexed()
	let live = () => host.state.clients.has(client)
	if (!indexed) tabs.greet(client, live)
	else
		void (client.held.set('*', []),
		indexed.then(() => live() && (tabs.greet(client, live), setImmediate(() => live() && host.release(client, '*')))))
	return {
		send: (command) => {
			if (host.state.clients.has(client)) host.handle(client, wire.copy(command))
		},
		close: () => {
			host.state.clients.delete(client)
			queueEdits.disconnect(client)
			if (client.visible) void recap.prepare(client.visible)
			clients.leave(client.record)
			serverLog.left(client.record)
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
	for (let c of held) host.handle(client, c)
}

// This process's version is known: every client hears it (task n1).
function announce(loaded: string): void {
	for (let client of host.state.clients) client.deliver({ type: 'version', version: loaded })
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
const once = new Set([
	'rebase-apply',
	'rebase-error',
	'create',
	'submit',
	'draft',
	'pause',
	'continue',
	'answer',
	'attach',
	'tab-new',
	'tab-close',
	'tab-resume',
	'tab-move',
	'tab-start',
])

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
	let problem = commandCheck.invalid(command)
	if (problem) return host.reject(client, command, problem, (command as any)?.sessionId)
	let c = command as Command
	let repeat = c.id === undefined ? undefined : (host.state.done.get(c.id) ?? host.submitted(c))
	if (repeat) {
		queueEdits.repeated(client, c, repeat.refused)
		return host.answer(client, c, repeat)
	}
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
	let seen = (r: HistoryRecord) =>
		((r.type === 'user' || r.type === 'command') && r.command === c.id) ||
		(r.type === 'inbox' && (r.id === c.id || r.command === c.id))
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
	if (c.type === 'find') {
		find.search(client, c.request, c.query, c.kinds, client.deliver)
		return {}
	}
	if (c.type === 'find-cancel') {
		find.cancel(client)
		return {}
	}
	if (c.type === 'create' || c.type === 'open-newest') {
		let id = c.type === 'open-newest' ? sessions.newest() : undefined
		if (id) return host.act(client, { type: 'open', sessionId: id, ...(c.id === undefined ? {} : { id: c.id }) })
		id = sessions.create(c.type === 'create' ? c : { cwd: c.cwd ?? host.cwd() }).id
		greetings.open(id, client.record.timezone)
		host.follow(client, id)
		return { sessionId: id }
	}
	if (c.type === 'open') {
		let id = c.sessionId
		let measured = client.record.kind === 'web' && settings.webDiagnostics()
		let start = measured ? performance.now() : 0
		let tab = measured ? tabs.file().open.indexOf(id) + 1 : 0
		if (measured) webDiagnostics.load(tab, 'requested', start)
		let ready = host.ready(id)
		if (measured && !ready) webDiagnostics.load(tab, 'ready', start)
		let tail = ready ? undefined : pages.slices(pages.snapshotSteps(id))
		if (tail && !(tail instanceof Promise)) {
			if (measured) webDiagnostics.load(tab, 'tail', start)
			host.follow(client, id, tail)
			return {}
		}
		client.held.set(id, [])
		return (async () => {
			await ready
			if (measured && ready) webDiagnostics.load(tab, 'ready', start)
			let loaded = await (tail ?? pages.slices(pages.snapshotSteps(id)))
			if (measured) webDiagnostics.load(tab, 'tail', start)
			host.follow(client, id, loaded)
			return {}
		})()
	}
	if (c.type === 'tab-close') {
		// Other clients hear it; this one already sees the tab go (task 97r).
		let before = tabs.list()
		let outcome = tabs.act(c, client.record.timezone)
		if (!outcome.refused) notify.closed(host.state.clients, c.sessionId, 'User closed the tab', before, client)
		return outcome
	}
	if (tabs.is(c)) return tabs.act(c, client.record.timezone)
	if (c.type === 'push-subscribe' || c.type === 'push') return push.command(c).then((reply) => ({ reply }))
	if (c.type === 'notice-history' || c.type === 'plugin-sync')
		return c.type === 'plugin-sync'
			? pluginSync.command(client, c)
			: { reply: { type: 'notice-history', entries: noticeHistory.list() } }
	if (c.type === 'handover')
		return client.record.kind !== 'peer'
			? { refused: 'handover: only a process on the host socket may ask' }
			: serverLog.state.on
				? { refused: 'hal serve already hosts this home' }
				: (handover.request(), {})
	if (c.type === 'terminal-error')
		return (diag.log(`${client.record.kind} client pid ${client.record.pid ?? '?'}: ${c.text}`), {})
	if (c.type === 'hello' || c.type === 'screen')
		return c.type === 'hello'
			? clients.hello(client.record, c.pid, c.version, c.newCode)
			: clients.screen(client.record, c)
	if (c.type === 'visibility') {
		// A known tab may still be waiting for its open snapshot.
		if (!client.open.has(c.sessionId) && !tabs.file().open.includes(c.sessionId))
			return { refused: 'visibility: session is not an open tab or followed session' }
		let previous = client.visible
		if (client.shown !== undefined && client.shown !== c.sessionId) tabs.left(client.shown)
		client.visible = c.visible ? c.sessionId : undefined
		client.shown = c.sessionId
		client.visibleAt = Date.now()
		recap.visibility(previous, client.visible)
		return {}
	}
	if (c.type === 'auth') {
		if (c.link) webLinks.follow(client, client.deliver)
		return c.link ? {} : { reply: { type: 'auth', code: webAuth.issue() } }
	}
	if (!client.open.has(c.sessionId)) return { refused: 'session is not open on this connection' }
	return sessionCommands.act(client, c)
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
	let measured = client.record.kind === 'web' && settings.webDiagnostics()
	let start = measured ? performance.now() : 0
	let snapshot = snapshots.build(id, tail && pages.since(id, tail))
	if (measured) webDiagnostics.load(tabs.file().open.indexOf(id) + 1, 'built', start)
	client.deliver({ type: 'snapshot', sessionId: id, snapshot })
}

function broadcast(id: string, event: Event): void {
	if (event.type === 'meta')
		event = { ...event, meta: { ...event.meta, slots: event.meta.slots ?? settings.subagentSlots() } }
	for (let client of host.state.clients) if (client.open.has(id)) client.deliver(event)
	tabs.observe(id, event)
	if (event.type === 'turn-end') void recap.prepare(id)
	notify.route(host.state.clients, id, event)
	work.changed(id, event)
	serverLog.event(id, event)
}

// When this process exits, stop all its work: save the output of running
// turns, stop them, and kill their commands. No command outlives the Hal
// that ran it.
//
// The turns stay unfinished, so the next Hal continues them. But if the
// user quit and no other Hal process is running, they are saved as paused
// instead: work the user stopped stays stopped until the user looks at it.
function init(): void {
	if (host.state.inited) return
	host.state.inited = true
	process.on('exit', () => {
		history.stop(userQuit.state.requested && server.state.sockets.size === 0)
		for (let r of turns.state.running.values()) r.controller.abort()
		jobs.killAll()
	})
	clock.init()
}
// Forgets every client and turn (tests).
function reset(): void {
	history.stop(false)
	queueEdits.state.clear()
	find.reset()
	recap.reset()
	for (let r of turns.state.running.values()) r.controller.abort()
	turns.state.running.clear()
	for (let running of tools.running.values()) running.controller.abort()
	tools.running.clear()
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
}
usage.clients = () => host.state.clients

export const host = {
	state: {
		clients: new Set<Client>(),
		// Sessions being opened from disk (history.open).
		opening: new Map<string, Promise<void>>(),
		// What each recent command id did, oldest first.
		done: new Map<string, Outcome>(),
		inited: false,
	},
	// Working directory for a session created without one.
	cwd: (): string => process.cwd(),
	// How many command ids the host remembers for spotting repeats.
	remembered: 1000,
	connect,
	adapt: wire.adapt,
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
	reset,
}
