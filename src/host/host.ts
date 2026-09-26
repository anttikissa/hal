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

import { ason } from '../common/ason.ts'
import { blocks, type DoneEvent, type ErrorEvent, type StreamEvent, type ToolResultBlock } from '../common/blocks.ts'
import { protocol, type Command, type Event, type Snapshot } from '../common/protocol.ts'
import { config } from './config.ts'
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
		else if (c.type === 'cancel') host.cancel(client, c.sessionId)
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
	let snap: Snapshot = { meta: { ...sessions.open(id) }, history: history.readSync(id) }
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

function submit(client: Client, id: string, text: string): void {
	if (host.state.running.has(id)) return host.reject(client, { type: 'submit' }, 'a turn is already running in this session', id)
	let model = sessions.open(id).model
	let running: Running = { provider: blocks.parseModelId(model)?.provider ?? model, controller: new AbortController() }
	history.submit(id, text)
	host.state.running.set(id, running)
	host.broadcast(id, { type: 'turn-start', sessionId: id, prompt: text, provider: running.provider })
	void host.runTurn(id, model, running)
}

function cancel(client: Client, id: string): void {
	let running = host.state.running.get(id)
	if (!running) return host.reject(client, { type: 'cancel' }, 'no turn is running in this session', id)
	running.controller.abort()
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
// host that dies in between leaves an unanswered call: history.open
// closes the turn as interrupted and nothing runs it again (replay.ts).
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
			for await (let event of history.record(id, running.provider, stream())) {
				blocks.apply(round, event)
				if (event.type === 'done' || event.type === 'error') {
					last = event
					break
				}
				if (signal.aborted) break
				host.broadcast(id, { type: 'stream', sessionId: id, event })
			}
			let calls = round.blocks.filter((b) => b.type === 'tool_call')
			if (last?.type !== 'done' || !calls.length) break
			// The turn wanted to go on: a cancel now stops it as cancelled.
			let cancelled = () => signal.aborted && ((last = undefined), true)
			if (cancelled()) break
			let cwd = sessions.open(id).cwd
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
}

// Records running turns as interrupted whenever this process exits
// (a restart included) while it is host. Idempotent.
function init(): void {
	if (host.state.inited) return
	host.state.inited = true
	process.on('exit', () => history.interrupt())
}

// Forgets every client and turn (tests).
function reset(): void {
	for (let r of host.state.running.values()) r.controller.abort()
	host.state.running.clear()
	host.state.opening.clear()
	host.state.clients.clear()
}

export const host = {
	state: {
		clients: new Set<Client>(),
		running: new Map<string, Running>(),
		// Sessions being opened from disk (history.open).
		opening: new Map<string, Promise<void>>(),
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
	submit,
	cancel,
	runTurn,
	reset,
}
