// The host end of the protocol (src/common/protocol.ts). It alone owns
// sessions, provider calls and state writes; clients only send commands
// and receive events. connect() is the in-memory connection; a socket
// transport wraps it by serializing both directions.
//
// Snapshot and live events are sent from the same synchronous step, so a
// client that opens a session never misses or double-counts an event.

import { ason } from '../common/ason.ts'
import { blocks, type Message, type StreamEvent, type Turn, type UserBlock } from '../common/blocks.ts'
import { protocol, type Command, type Entry, type Event, type Snapshot } from '../common/protocol.ts'
import { provider, type ProviderRequest } from './provider.ts'
import { sessions } from './sessions.ts'

export type Connection = {
	// Takes unvalidated data: the peer may be another process.
	send(command: unknown): void
	close(): void
}

type Client = { deliver: (event: Event) => void; open: Set<string> }
type Running = { turn: Turn; controller: AbortController }

// The in-memory stand-in for the wire: both directions go through ASON,
// so nothing non-serializable or shared by reference crosses it.
function wire<T>(value: T): T {
	return ason.parse(ason.stringify(value, 'short')) as T
}

function connect(deliver: (event: Event) => void): Connection {
	let client: Client = { deliver: (e) => deliver(wire(e)), open: new Set() }
	host.state.clients.add(client)
	return {
		send: (command) => {
			if (host.state.clients.has(client)) host.handle(client, wire(command))
		},
		close: () => {
			host.state.clients.delete(client)
		},
	}
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
			sessions.open(c.sessionId)
			return host.follow(client, c.sessionId)
		}
		if (!client.open.has(c.sessionId)) return host.reject(client, c, 'session is not open on this connection', c.sessionId)
		if (c.type === 'close') client.open.delete(c.sessionId)
		else if (c.type === 'submit') host.submit(client, c.sessionId, c.text)
		else if (c.type === 'cancel') host.cancel(client, c.sessionId)
	} catch (e: any) {
		host.reject(client, c, String(e?.message ?? e), 'sessionId' in c ? c.sessionId : undefined)
	}
}

function follow(client: Client, id: string): void {
	client.open.add(id)
	client.deliver({ type: 'snapshot', sessionId: id, snapshot: host.snapshot(id) })
}

function snapshot(id: string): Snapshot {
	let snap: Snapshot = { meta: { ...sessions.open(id) }, history: host.history(id) }
	let running = host.state.running.get(id)
	if (running) snap.turn = { provider: running.turn.provider, blocks: running.turn.blocks, usage: running.turn.usage }
	return snap
}

function broadcast(id: string, event: Event): void {
	for (let client of host.state.clients) if (client.open.has(id)) client.deliver(event)
}

// Conversation so far. In memory until durable history replaces these
// two functions; nothing else touches the storage.
function history(id: string): Entry[] {
	return host.state.history.get(id) ?? []
}

function record(id: string, entry: Entry): void {
	let list = host.state.history.get(id)
	if (list) list.push(entry)
	else host.state.history.set(id, [entry])
}

// Provider messages rebuilt from history alone.
function input(id: string): Message[] {
	let out: Message[] = []
	for (let e of host.history(id)) {
		if (e.type === 'prompt') {
			let block: UserBlock = { type: 'text', text: e.text }
			let last = out.at(-1)
			if (last?.role === 'user') last.blocks.push(block)
			else out.push({ role: 'user', blocks: [block] })
		} else if (e.type === 'assistant') out.push({ role: 'assistant', blocks: e.blocks })
	}
	return out
}

function submit(client: Client, id: string, text: string): void {
	if (host.state.running.has(id)) return host.reject(client, { type: 'submit' }, 'a turn is already running in this session', id)
	let model = sessions.open(id).model
	let running: Running = {
		turn: blocks.newTurn(blocks.parseModelId(model)?.provider ?? ''),
		controller: new AbortController(),
	}
	host.state.running.set(id, running)
	host.record(id, { type: 'prompt', text })
	host.broadcast(id, { type: 'turn-start', sessionId: id, prompt: text, provider: running.turn.provider })
	void host.runTurn(id, model, running)
}

function cancel(client: Client, id: string): void {
	let running = host.state.running.get(id)
	if (!running) return host.reject(client, { type: 'cancel' }, 'no turn is running in this session', id)
	running.controller.abort()
}

// Streams one turn and always ends it: records the output and the turn
// end, frees the session and tells followers, whatever the stream does.
async function runTurn(id: string, model: string, running: Running): Promise<void> {
	let { turn, controller } = running
	try {
		let events = host.stream(model, { messages: host.input(id) }, controller.signal)
		for await (let event of events) {
			blocks.apply(turn, event)
			if (event.type === 'done' || event.type === 'error' || controller.signal.aborted) break
			host.broadcast(id, { type: 'stream', sessionId: id, event })
		}
	} catch (e: any) {
		turn.end = { type: 'error', message: String(e?.message ?? e) }
	}
	// A reset host has forgotten this turn; don't write into its successor.
	if (host.state.running.get(id) !== running) return
	let end: Entry & { type: 'turn-end' } = { type: 'turn-end', status: 'completed' }
	if (controller.signal.aborted || (turn.end?.type === 'error' && turn.end.cancelled)) end.status = 'cancelled'
	else if (turn.end?.type !== 'done') {
		end.status = 'error'
		end.error = turn.end?.type === 'error' ? turn.end.message : 'Stream ended without finishing'
	}
	if (Object.keys(turn.usage).length) end.usage = turn.usage
	if (turn.blocks.length) host.record(id, { type: 'assistant', blocks: turn.blocks })
	host.record(id, end)
	host.state.running.delete(id)
	host.broadcast(id, { sessionId: id, ...end })
}

// Forgets every client, turn and in-memory history (tests).
function reset(): void {
	for (let r of host.state.running.values()) r.controller.abort()
	host.state.running.clear()
	host.state.clients.clear()
	host.state.history.clear()
}

export const host = {
	state: {
		clients: new Set<Client>(),
		running: new Map<string, Running>(),
		history: new Map<string, Entry[]>(),
	},
	stream: (model: string, input: Omit<ProviderRequest, 'model'>, signal?: AbortSignal): AsyncIterable<StreamEvent> =>
		provider.stream(model, input, signal),
	connect,
	handle,
	reject,
	follow,
	snapshot,
	broadcast,
	history,
	record,
	input,
	submit,
	cancel,
	runTurn,
	reset,
}
