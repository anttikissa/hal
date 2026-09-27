// A client's connection to the host, the same for the terminal, a peer
// and the browser; only the transport differs (client/link.ts: in
// process or Unix socket, web/link.ts: WebSocket). States
// (tasks/j1/states.md): joining, connected as host or client, or
// disconnected until a retry time.
//
// Reconnecting is connecting plus re-opening: every session this client
// follows arrives as a fresh snapshot. Every command gets an id made
// here and stays pending until the host acknowledges or rejects it; a
// pending command is sent again on the next connection, and the host
// ignores repeats, so it never acts twice.

import type { Event } from './protocol.ts'
import { perf } from './perf.ts'

export type Role = 'host' | 'client'
export type Conn = { send(command: object): void; close(): void }
export type LinkState = { type: 'joining' } | { type: 'connected'; role: Role } | { type: 'disconnected'; retryAt: number }

// One attempt to reach the host: a connection, or null if nobody
// answered. After resolving a connection, the transport calls dropped()
// once when it goes away. Throwing counts as a failed attempt, except on
// the very first one, which makes start() fail.
export type Transport = {
	connect(on: { event(event: Event): void; dropped(): void }): Promise<{ conn: Conn; role: Role } | null>
}

export type ConnectionOptions = {
	transport: Transport
	onEvent: (event: Event) => void
	onState?: (state: LinkState) => void
	// Retry after failure n (0-based) waits about baseMs * 2^n, at most
	// maxMs, with jitter so clients that lost one host spread out.
	baseMs: number
	maxMs: number
}

type Command = { type: string; id?: string; sessionId?: string }

type ConnectionState = {
	opts: ConnectionOptions | null
	link: LinkState
	conn: Conn | null
	// The current attempt; events from older ones are ignored.
	attempt: object | null
	// Sessions to re-open after reconnecting.
	followed: Set<string>
	// Commands sent but not yet answered, by id, in sending order.
	pending: Map<string, Command>
	failures: number
	joined: boolean
	// Settles start() on the first connection or a failed first attempt.
	first: { resolve(): void; reject(e: unknown): void } | null
	stopped: boolean
	timer: ReturnType<typeof setTimeout> | null
	// Prefix for command ids, fresh for each start.
	client: string
	sent: number
}

function createState(): ConnectionState {
	return {
		opts: null,
		link: { type: 'joining' },
		conn: null,
		attempt: null,
		followed: new Set(),
		pending: new Map(),
		failures: 0,
		joined: false,
		first: null,
		stopped: true,
		timer: null,
		client: '',
		sent: 0,
	}
}

function setLink(link: LinkState): void {
	connection.state.link = link
	connection.state.opts?.onState?.(link)
}

// Joins, resolving once connected the first time; rejects if the first
// attempt throws.
function start(opts: ConnectionOptions): Promise<void> {
	connection.stop()
	connection.state = { ...createState(), opts, stopped: false, client: Math.random().toString(36).slice(2, 10) }
	return new Promise((resolve, reject) => {
		connection.state.first = { resolve, reject }
		void connection.attempt()
	})
}

async function attempt(): Promise<void> {
	let st = connection.state
	if (st.stopped) return
	let token = {}
	st.attempt = token
	st.timer = null
	connection.setLink({ type: 'joining' })
	let current = () => connection.state === st && st.attempt === token && !st.stopped
	let got: Awaited<ReturnType<Transport['connect']>> = null
	try {
		got = await st.opts!.transport.connect({
			event: (event) => current() && connection.receive(event),
			dropped: () => current() && st.conn && connection.dropped(),
		})
	} catch (e) {
		if (!st.joined) {
			st.stopped = true
			return st.first?.reject(e)
		}
	}
	if (!current()) return got?.conn.close()
	if (!got) return connection.retry()
	connection.attach(got.conn, got.role)
}

function attach(conn: Conn, role: Role): void {
	let st = connection.state
	st.conn = conn
	st.failures = 0
	perf.mark('connected', role)
	for (let id of st.followed) conn.send({ type: 'open', sessionId: id, id: connection.nextId() })
	for (let command of st.pending.values()) {
		if (command.type === 'open' && st.followed.has(command.sessionId!)) st.pending.delete(command.id!)
		else conn.send(command)
	}
	// Last: what the client sends on hearing it is sent once, not again
	// by the loops above.
	connection.setLink({ type: 'connected', role })
	if (!st.joined) {
		st.joined = true
		st.first?.resolve()
	}
}

function dropped(): void {
	connection.state.conn = null
	void connection.attempt()
}

// Waits before the next attempt, longer after each failure.
function retry(): void {
	let st = connection.state
	let wait = connection.delay(st.failures++)
	connection.setLink({ type: 'disconnected', retryAt: Date.now() + wait })
	st.timer = connection.schedule(() => connection.attempt(), wait)
}

function delay(failures: number): number {
	let { baseMs, maxMs } = connection.state.opts!
	return Math.min(maxMs, baseMs * 2 ** failures) * (0.5 + connection.random())
}

function receive(event: Event): void {
	let st = connection.state
	if (event.type === 'snapshot') st.followed.add(event.sessionId)
	if (event.type === 'ack') st.pending.delete(event.id)
	if (event.type === 'rejected' && event.id !== undefined) {
		let command = st.pending.get(event.id)
		st.pending.delete(event.id)
		if (command?.type === 'open' && command.sessionId) st.followed.delete(command.sessionId)
	}
	st.opts?.onEvent(event)
}

function nextId(): string {
	let st = connection.state
	return `${st.client}.${++st.sent}`
}

// Sends a command now if connected, else on the next connection. It
// stays pending, and is sent again after a reconnect, until answered.
function send(command: unknown): void {
	let st = connection.state
	let c = { ...(command as Command), id: (command as Command).id ?? connection.nextId() }
	if (c.type === 'close' && c.sessionId) st.followed.delete(c.sessionId)
	st.pending.set(c.id!, c)
	st.conn?.send(c)
}

function connected(): boolean {
	return connection.state.link.type === 'connected'
}

function stop(): void {
	let st = connection.state
	st.stopped = true
	if (st.timer !== null) clearTimeout(st.timer)
	st.timer = null
	let conn = st.conn
	st.conn = null
	conn?.close()
}

export const connection = {
	state: createState(),
	random: () => Math.random(),
	schedule: (fn: () => void, ms: number): ReturnType<typeof setTimeout> => setTimeout(fn, ms),
	setLink,
	start,
	attempt,
	attach,
	dropped,
	retry,
	delay,
	receive,
	nextId,
	send,
	connected,
	stop,
}
