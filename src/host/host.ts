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

import { ason } from '../common/ason.ts'
import { blocks, type DoneEvent, type ErrorEvent, type StreamEvent, type ToolResultBlock } from '../common/blocks.ts'
import { protocol, type Command, type Event, type Snapshot } from '../common/protocol.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { states, type SessionState, type StateEvent } from '../common/states.ts'
import { config } from './config.ts'
import { diag } from './diag.ts'
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
	let type = (command as { type?: unknown } | null)?.type
	let event: Event = { type: 'rejected', command: typeof type === 'string' ? type : String(type), reason }
	if (typeof sessionId === 'string') event.sessionId = sessionId
	client.deliver(event)
}

function handle(client: Client, command: unknown): void {
	let problem = protocol.invalid(command)
	if (problem) return host.reject(client, command, problem, (command as any)?.sessionId)
	let c = command as Command
	try {
		if (c.type === 'create') {
			let init: { cwd: string; model?: string; name?: string } = { cwd: c.cwd }
			if (c.model !== undefined) init.model = c.model
			if (c.name !== undefined) init.name = c.name
			return host.follow(client, sessions.create(init).id)
		}
		if (c.type === 'open') {
			let ready = host.ready(c.sessionId)
			if (!ready) return host.follow(client, c.sessionId)
			// Once open, the same command takes the synchronous path.
			ready.then(
				() => host.state.clients.has(client) && host.handle(client, c),
				(e) => host.reject(client, c, String(e?.message ?? e), c.sessionId),
			)
			return
		}
		if (!client.open.has(c.sessionId)) return host.reject(client, c, 'session is not open on this connection', c.sessionId)
		if (c.type === 'close') client.open.delete(c.sessionId)
		else if (c.type === 'submit') host.submit(client, c.sessionId, c.text)
		else if (c.type === 'continue') host.resume(client, c.sessionId)
		else if (c.type === 'pause') host.pause(client, c.sessionId)
	} catch (e: any) {
		host.reject(client, c, String(e?.message ?? e), 'sessionId' in c ? c.sessionId : undefined)
	}
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
	let snap: Snapshot = { meta: { ...sessions.open(id) }, history: records, state: host.stateOf(id, records) }
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

function submit(client: Client, id: string, text: string): void {
	let refused = host.transition(id, { type: 'submit' })
	if (refused) return host.reject(client, { type: 'submit' }, refused, id)
	history.submit(id, text)
	host.start(id, text)
}

// Continue: a paused turn goes on, a failed one retries.
function resume(client: Client, id: string): void {
	let refused = host.transition(id, { type: 'continue' })
	if (refused) return host.reject(client, { type: 'continue' }, refused, id)
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

// Escape.
function pause(client: Client, id: string): void {
	let refused = host.stop(id)
	if (refused) host.reject(client, { type: 'pause' }, refused, id)
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
// progress it is paused with a reason instead.
async function recover(): Promise<void> {
	for (let listing of sessions.list()) {
		let id = listing.id
		if (!listing.meta || host.state.running.has(id) || !history.unfinished(id)) continue
		try {
			await (host.ready(id) ?? Promise.resolve())
		} catch (e: any) {
			diag.log(`recover ${id}: ${e?.message ?? e}`)
			continue
		}
		let records = history.readSync(id)
		if (host.state.running.has(id) || host.stateOf(id, records).type !== 'running') continue
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
async function runTurn(id: string, model: string, running: Running): Promise<void> {
	let { signal } = running.controller
	async function* stream(): AsyncGenerator<StreamEvent> {
		yield* host.stream(model, { messages: await history.messages(id), tools: tools.defs() }, signal)
	}
	let last: DoneEvent | ErrorEvent | undefined
	let failure: string | undefined
	try {
		while (true) {
			let round = blocks.newTurn(running.provider)
			last = undefined
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
			let calls = round.blocks.filter((b) => b.type === 'tool_call')
			if (last?.type !== 'done' || !calls.length) break
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
}

// Whenever this process exits while it is host, writes the output of
// running turns so far and leaves them unfinished, for the next host to
// continue; or, if the user quit the last Hal process (quitting()),
// records them paused. Idempotent.
function init(): void {
	if (host.state.inited) return
	host.state.inited = true
	process.on('exit', () => history.stop(host.state.pauseOnExit))
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
		pauseOnExit: false,
		inited: false,
	},
	stream: (model: string, input: Omit<ProviderRequest, 'model'>, signal?: AbortSignal): AsyncIterable<StreamEvent> =>
		provider.stream(model, input, signal),
	init,
	connect,
	handle,
	warn,
	warnAll,
	reject,
	ready,
	follow,
	snapshot,
	broadcast,
	stateOf,
	transition,
	submit,
	resume,
	start,
	pause,
	stop,
	recover,
	runTurn,
	quitting,
	reset,
}
