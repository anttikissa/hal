// The host end of the protocol (src/common/protocol.ts). It alone owns
// sessions, provider calls and state writes; clients only send commands
// and receive events. connect() is the in-memory connection; a socket
// transport wraps it by serializing both directions.
//
// Snapshot and live events are sent from the same synchronous step, so a
// client that opens a session never misses or double-counts an event.
// The conversation lives only in durable history (history.ts): prompts,
// finished blocks, tool results and turn ends are on disk before clients
// hear of them, and snapshots and provider input are read back from
// there.
//
// Each session is in one state (src/common/states.ts, tasks/j1/states.md):
// derived from history when the session is opened, then moved by
// states.step as commands and the turn go on, and broadcast when it
// changes. Only the user pauses a turn. A turn with no end record is
// unfinished; whichever process becomes host continues it (recover).
//
// Sending while a turn is busy puts the message in the session inbox
// (src/common/inbox.ts), durable in history: steering messages go to
// the model together before the turn's next request, queued ones run as
// turns of their own once it has completed.

import { ason } from '../common/ason.ts'
import { inbox, type InboxItem } from '../common/inbox.ts'
import { blocks, type DoneEvent, type ErrorEvent, type StreamEvent, type ToolResultBlock } from '../common/blocks.ts'
import { protocol, type Command, type Event, type Snapshot } from '../common/protocol.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { states, type SessionState, type StateEvent } from '../common/states.ts'
import { auth } from './auth.ts'
import { clock } from './clock.ts'
import { config } from './config.ts'
import { diag } from './diag.ts'
import { drafts } from './drafts.ts'
import { history } from './history.ts'
import { provider, type ProviderRequest } from './provider.ts'
import { sessions } from './sessions.ts'
import { tools } from './tools.ts'

export type Connection = {
	// Takes unvalidated data: the peer may be another process.
	send(command: unknown): void
	close(): void
}

type Client = { deliver: (event: Event) => void; open: Set<string> }
// What a command did: refused (why), or done, naming a created session.
type Outcome = { refused?: string; sessionId?: string }
type Running = { provider: string; controller: AbortController }

// The in-memory stand-in for the wire: both directions go through ASON,
// so nothing non-serializable or shared by reference crosses it.
function wire<T>(value: T): T {
	return ason.parse(ason.stringify(value, 'short')) as T
}

function connect(deliver: (event: Event) => void): Connection {
	let client: Client = { deliver: (e) => deliver(wire(e)), open: new Set() }
	host.state.clients.add(client)
	host.warn(client)
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
const once = new Set(['create', 'submit', 'draft', 'pause', 'continue'])

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
	let seen = (r: HistoryRecord) => (r.type === 'user' && r.command === c.id) || (r.type === 'inbox' && r.id === c.id)
	return history.readSync(c.sessionId).some(seen) ? {} : undefined
}

// Acknowledges or rejects a command. A repeated create follows its
// session again, so the resender sees it too.
function answer(client: Client, c: Command, outcome: Outcome, repeat = true): void {
	let sessionId = 'sessionId' in c ? c.sessionId : outcome.sessionId
	if (outcome.refused !== undefined) return host.reject(client, c, outcome.refused, sessionId)
	if (repeat && outcome.sessionId) host.follow(client, outcome.sessionId)
	if (c.id !== undefined) client.deliver({ type: 'ack', id: c.id })
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
	if (!client.open.has(c.sessionId)) return { refused: 'session is not open on this connection' }
	let refused: string | undefined
	if (c.type === 'close') client.open.delete(c.sessionId)
	else if (c.type === 'submit') {
		refused = host.submit(c.sessionId, c.text, c.id, c.queue)
		if (refused === undefined) host.sent(c.sessionId, c.text, c.id)
	} else if (c.type === 'draft') host.draft(c.sessionId, drafts.set(c.sessionId, c.text, c.base), c.id)
	else if (c.type === 'continue') refused = host.resume(c.sessionId)
	else if (c.type === 'pause') refused = host.stop(c.sessionId)
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
	let records = history.readSync(id)
	let snap: Snapshot = { meta: { ...sessions.open(id) }, history: records, state: host.stateOf(id, records), inbox: host.inboxOf(id, records) }
	try {
		let draft = drafts.get(id)
		if (draft.rev) snap.draft = draft
	} catch (e: any) {
		// A malformed draft.ason stays on disk untouched; the session opens.
		diag.log(`draft ${id}: ${e?.message ?? e}`)
	}
	let running = host.state.running.get(id)
	if (running) {
		let live = history.live(id)
		snap.turn = { provider: running.provider, blocks: live?.blocks ?? [], usage: live?.usage ?? {} }
	}
	return snap
}

function broadcast(id: string, event: Event): void {
	for (let client of host.state.clients) if (client.open.has(id)) client.deliver(event)
}

// The session's state: what this host last made it, else what its
// history says.
function stateOf(id: string, records?: ReturnType<typeof history.readSync>): SessionState {
	return host.state.states.get(id) ?? states.fromHistory(records ?? history.readSync(id))
}

// Moves the session's state on `event`, telling followers if it changed.
// Returns why the event is refused, if it is.
function transition(id: string, event: StateEvent): string | undefined {
	let before = host.stateOf(id)
	let next = states.step(before, event)
	if (typeof next === 'string') return next
	host.state.states.set(id, next)
	if (ason.stringify(next) !== ason.stringify(before)) host.broadcast(id, { type: 'state', sessionId: id, state: next })
	return undefined
}

// The messages waiting in the session's inbox.
function inboxOf(id: string, records?: HistoryRecord[]): InboxItem[] {
	return inbox.pending(records ?? history.readSync(id))
}

// Returns why the submit is refused, if it is. `command` is the
// client's id for it, kept with the prompt (or inbox message) so a
// later host can tell a resend. While the session is busy the message
// waits in the inbox; `queue` also makes it wait for a paused or failed
// turn to finish. Otherwise it starts a turn, delivering any steering
// messages still waiting (a paused turn's) first.
function submit(id: string, text: string, command?: string, queue = false): string | undefined {
	let state = host.stateOf(id)
	if (states.busy(state) || (queue && state.type !== 'idle')) {
		let record: Omit<HistoryRecord & { type: 'inbox' }, 'ts'> = { type: 'inbox', id: command ?? crypto.randomUUID(), text }
		if (queue) record.queue = true
		history.append(id, record)
		host.broadcast(id, { type: 'inbox', sessionId: id, inbox: host.inboxOf(id) })
		return
	}
	let refused = host.transition(id, { type: 'submit' })
	if (refused) return refused
	let steering = host.inboxOf(id).filter((m) => !m.queue)
	if (!steering.length) {
		history.submit(id, text, command)
		return void host.start(id, text)
	}
	host.deliver(id, steering, text, command)
	host.start(id)
}

// Records inbox messages (and a new prompt `text`) as one prompt and
// tells followers: a `prompt` event, or with `quiet` nothing, as the
// caller's turn-start carries it.
function deliver(id: string, items: InboxItem[], text?: string, command?: string, quiet = false): void {
	let texts = items.map((m) => m.text)
	if (text !== undefined) texts.push(text)
	let record: Omit<HistoryRecord & { type: 'user' }, 'ts'> = { type: 'user', blocks: texts.map((t) => ({ type: 'text', text: t })), inbox: items.map((m) => m.id) }
	if (command !== undefined) record.command = command
	history.append(id, record)
	host.broadcast(id, { type: 'inbox', sessionId: id, inbox: host.inboxOf(id) })
	if (!quiet) host.broadcast(id, { type: 'prompt', sessionId: id, texts })
}

// Before a request: delivers the steering messages waiting, if any.
function steer(id: string): void {
	let steering = host.inboxOf(id).filter((m) => !m.queue)
	if (steering.length) host.deliver(id, steering)
}

// After a completed turn: runs the oldest queued message, if any.
function next(id: string): void {
	let queued = host.inboxOf(id).find((m) => m.queue)
	if (!queued || host.transition(id, { type: 'submit' })) return
	host.deliver(id, [queued], undefined, undefined, true)
	host.start(id, queued.text)
}

// After a submit: the draft it was typed in is sent, so it clears
// (drafts.sent), and followers hear it with the submit's id.
function sent(id: string, text: string, command?: string): void {
	try {
		host.draft(id, drafts.sent(id, text), command)
	} catch (e: any) {
		diag.log(`draft ${id}: ${e?.message ?? e}`)
	}
}

// Tells followers the session's draft changed (if it did), naming the
// command that changed it.
function draft(id: string, changed: ReturnType<typeof drafts.get> | undefined, command?: string): void {
	if (!changed) return
	let event: Event = { type: 'draft', sessionId: id, draft: changed }
	if (command !== undefined) event.command = command
	host.broadcast(id, event)
}

// Continue: a paused turn goes on, a failed one retries.
function resume(id: string): string | undefined {
	let refused = host.transition(id, { type: 'continue' })
	if (refused) return refused
	history.append(id, { type: 'continue' })
	host.start(id)
}

// Runs a turn whose prompt or `continue` record is in history.
function start(id: string, prompt?: string): void {
	let model = sessions.open(id).model
	let running: Running = { provider: blocks.parseModelId(model)?.provider ?? model, controller: new AbortController() }
	host.state.running.set(id, running)
	let event: Event = { type: 'turn-start', sessionId: id, provider: running.provider }
	if (prompt !== undefined) event.prompt = prompt
	host.broadcast(id, event)
	void host.runTurn(id, model, running)
}

// Pauses the session's turn: one running here stops and runTurn records
// it paused; one not running here (unfinished on disk) is paused on disk.
function stop(id: string, reason?: string): string | undefined {
	let event: StateEvent = { type: 'pause' }
	if (reason !== undefined) event.reason = reason
	let refused = host.transition(id, event)
	if (refused) return refused
	let running = host.state.running.get(id)
	if (running) return void running.controller.abort()
	let end: Omit<HistoryRecord & { type: 'turn_end' }, 'ts'> = { type: 'turn_end', status: 'paused', usage: {} }
	if (reason !== undefined) end.pauseReason = reason
	history.append(id, end)
	host.broadcast(id, { type: 'turn-end', sessionId: id, status: 'paused' })
}

// Continues every unfinished turn on disk (a new host after a restart or
// a host that went away). A turn that keeps bringing hosts down would
// loop forever, so after states.maxRecoveries() continuations without
// progress it is paused with a reason instead. An idle session whose
// inbox still holds queued messages (the host died between a turn end
// and the next queued prompt) runs the oldest, as host.next would have.
async function recover(): Promise<void> {
	for (let listing of sessions.list()) {
		let id = listing.id
		if (!listing.meta || host.state.running.has(id)) continue
		let tail = history.tail(id)
		let last = tail.at(-1)
		if (!last) continue
		// Only the tail is read (all histories would be slow): a queued
		// message older than both it and the last prompt in it is missed.
		let queued = last.type === 'turn_end' && last.status === 'completed' && (tail.some((r) => r.type === 'inbox' && r.queue) || !tail.some((r) => r.type === 'user'))
		if (last.type === 'turn_end' && !queued) continue
		try {
			await (host.ready(id) ?? Promise.resolve())
		} catch (e: any) {
			diag.log(`recover ${id}: ${e?.message ?? e}`)
			continue
		}
		let records = history.readSync(id)
		if (host.state.running.has(id)) continue
		let state = host.stateOf(id, records)
		if (state.type === 'idle') {
			host.next(id)
			continue
		}
		if (state.type !== 'running') continue
		let n = states.recoveries(records)
		if (n >= states.maxRecoveries()) {
			host.stop(id, `continued ${n} times without progress; it may be what stops the host`)
			continue
		}
		history.append(id, { type: 'continue' })
		host.start(id)
	}
}

// Runs one turn and always ends it. A turn is every provider round from
// the prompt to the model's answer: while a round ends asking for tools,
// the host runs them, records their results and starts the next round.
// Blocks and results are in history before followers hear of them, and
// there is one turn end, with the usage of all rounds. Provider input is
// read from history inside the recorded stream, so a failure to build
// it ends the turn too.
//
// A tool call is recorded before it runs and its result after, so a
// host that dies in between leaves an unanswered call: the next host
// continues the turn, telling the model it may or may not have run, and
// never runs it again (replay.ts).
//
// A round that fails in a way the host can fix (error.failure,
// provider.ts) is tried again within the turn: retrying at a time, or
// blocked on a login; only the user's Escape stops that.
async function runTurn(id: string, model: string, running: Running): Promise<void> {
	let { signal } = running.controller
	async function* stream(): AsyncGenerator<StreamEvent> {
		yield* host.stream(model, { messages: await history.messages(id), tools: tools.defs() }, signal)
	}
	let last: DoneEvent | ErrorEvent | undefined
	let failure: string | undefined
	// Failed rounds in a row, for the backoff.
	let failures = 0
	try {
		while (true) {
			let round = blocks.newTurn(running.provider)
			last = undefined
			host.steer(id)
			host.transition(id, { type: 'request' })
			for await (let event of history.record(id, running.provider, stream())) {
				blocks.apply(round, event)
				if (event.type === 'done' || event.type === 'error') {
					last = event
					break
				}
				if (signal.aborted) break
				host.transition(id, { type: 'stream' })
				host.broadcast(id, { type: 'stream', sessionId: id, event })
			}
			if (last?.type === 'error' && last.failure && !last.cancelled && !signal.aborted) {
				await host.waitOut(id, last, failures++, signal)
				if (host.state.running.get(id) !== running) return
				if (signal.aborted) {
					last = undefined
					break
				}
				continue
			}
			if (last?.type === 'done') failures = 0
			let calls = round.blocks.filter((b) => b.type === 'tool_call')
			if (last?.type !== 'done') break
			// A finished answer with steering waiting: the model hears it.
			if (!calls.length) {
				if (signal.aborted || !host.inboxOf(id).some((m) => !m.queue)) break
				continue
			}
			// The turn wanted to go on: a pause now stops it as paused.
			let cancelled = () => signal.aborted && ((last = undefined), true)
			if (cancelled()) break
			let cwd = sessions.open(id).cwd
			host.transition(id, { type: 'tools' })
			let results: ToolResultBlock[] = []
			for (let call of calls) results.push(await tools.run(call, { cwd, signal }))
			if (host.state.running.get(id) !== running) return
			history.results(id, results)
			host.broadcast(id, { type: 'tool-results', sessionId: id, results })
			if (cancelled()) break
		}
	} catch (e: any) {
		failure = String(e?.message ?? e)
	}
	// A reset host has forgotten this turn; don't write into its successor.
	if (host.state.running.get(id) !== running) return
	host.state.running.delete(id)
	let recorded: ReturnType<typeof history.readSync>[number] | undefined
	try {
		history.end(id, failure !== undefined ? { type: 'error', message: failure } : last)
		recorded = history.readSync(id).at(-1)
	} catch (e: any) {
		failure ??= String(e?.message ?? e)
	}
	let end: Event & { type: 'turn-end' } = { type: 'turn-end', sessionId: id, status: 'error', error: failure ?? 'turn end was not recorded' }
	if (recorded?.type === 'turn_end') {
		end = { type: 'turn-end', sessionId: id, status: recorded.status }
		if (Object.keys(recorded.usage).length) end.usage = recorded.usage
		if (recorded.error !== undefined) end.error = recorded.error
	}
	host.broadcast(id, end)
	// Paused already, unless something other than the user aborted it.
	if (end.status === 'paused') host.transition(id, { type: 'pause' })
	else host.transition(id, end.status === 'error' ? { type: 'end', error: end.error ?? 'turn failed' } : { type: 'end' })
	if (end.status === 'completed') host.next(id)
}

// Waits out a failed round (tasks/j1/states.md, Failures) and shows
// why: retrying at a time (temporary: at once, then backing off; rate
// limited: when the provider said, or at once when another account can
// take over), or blocked until the credentials file changes (a broken
// login). Ends early on Escape (`signal`); a wake retries at once.
async function waitOut(id: string, error: ErrorEvent, failures: number, signal: AbortSignal): Promise<void> {
	// Output cut off mid-answer: the model hears it was interrupted.
	if (history.readSync(id).at(-1)?.type === 'assistant') history.append(id, { type: 'continue' })
	if (error.failure === 'auth' && error.retryAt === undefined) {
		host.transition(id, { type: 'block', reason: `log in: ${error.message}` })
		await auth.changed(signal)
		return
	}
	let at = error.retryAt ?? clock.now() + host.backoffMs(failures)
	host.transition(id, { type: 'retry', at: new Date(at).toISOString(), reason: error.message })
	await clock.until(at, signal)
}

// The wait before the next try after `failures` failed rounds in a
// row: none at first, then doubling up to half a minute.
function backoffMs(failures: number): number {
	return failures === 0 ? 0 : Math.min(1000 * 2 ** (failures - 1), 30_000)
}

// Whenever this process exits while it is host, writes the output of
// running turns so far and leaves them unfinished, for the next host to
// continue; or, if the user quit the last Hal process (quitting()),
// records them paused. Idempotent.
function init(): void {
	if (host.state.inited) return
	host.state.inited = true
	process.on('exit', () => history.stop(host.state.pauseOnExit))
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
	for (let r of host.state.running.values()) r.controller.abort()
	host.state.running.clear()
	host.state.opening.clear()
	host.state.clients.clear()
	host.state.states.clear()
	host.state.done.clear()
	drafts.reset()
	host.state.pauseOnExit = false
}

export const host = {
	state: {
		clients: new Set<Client>(),
		running: new Map<string, Running>(),
		// Sessions being opened from disk (history.open).
		opening: new Map<string, Promise<void>>(),
		// Each session's state, once this host has moved it.
		states: new Map<string, SessionState>(),
		// What each recent command id did, oldest first.
		done: new Map<string, Outcome>(),
		pauseOnExit: false,
		inited: false,
	},
	stream: (model: string, input: Omit<ProviderRequest, 'model'>, signal?: AbortSignal): AsyncIterable<StreamEvent> =>
		provider.stream(model, input, signal),
	// Working directory for a session created without one.
	cwd: (): string => process.cwd(),
	// How many command ids the host remembers for spotting repeats.
	remembered: () => 1000,
	init,
	connect,
	adapt,
	handle,
	remember,
	submitted,
	answer,
	act,
	warn,
	warnAll,
	reject,
	ready,
	follow,
	snapshot,
	broadcast,
	stateOf,
	transition,
	inboxOf,
	submit,
	deliver,
	steer,
	next,
	sent,
	draft,
	resume,
	start,
	stop,
	recover,
	runTurn,
	waitOut,
	backoffMs,
	quitting,
	reset,
}
