// The client's connection to its home's host, whoever that is. Joining
// means becoming host if nobody is (and then talking to the host in this
// process, through the same protocol), else connecting to its socket.
// When the connection drops, join again. Reconnecting is connecting plus
// re-opening: every session this client follows arrives as a fresh
// snapshot, so nothing is replayed and nothing is missed.

import { createConnection } from 'net'
import { ason } from '../common/ason.ts'
import { lines } from '../common/lines.ts'
import type { Event } from '../common/protocol.ts'

export type Conn = { send(command: unknown): void; close(): void }
export type Role = 'host' | 'client'

export type LinkOptions = {
	socketPath: string
	// Takes over as host if nobody holds the host lock; true on success.
	tryHost: () => Promise<boolean>
	// A connection to the host in this process.
	local: (deliver: (event: Event) => void) => Conn
	onEvent: (event: Event) => void
	// null while disconnected.
	onRole?: (role: Role | null) => void
}

type LinkState = {
	opts: LinkOptions | null
	conn: Conn | null
	role: Role | null
	// Sessions to re-open after reconnecting.
	open: Set<string>
	// Commands sent while disconnected; nobody has seen them yet.
	queue: unknown[]
	stopped: boolean
	// Has been connected at least once.
	joined: boolean
	joining: Promise<void> | null
}

function createState(): LinkState {
	return { opts: null, conn: null, role: null, open: new Set(), queue: [], stopped: false, joined: false, joining: null }
}

// Joins, resolving once connected (as host or client).
function start(opts: LinkOptions): Promise<void> {
	link.state = { ...createState(), opts }
	return link.join()
}

function join(): Promise<void> {
	link.state.joining ??= link.joinLoop().finally(() => (link.state.joining = null))
	return link.state.joining
}

async function joinLoop(): Promise<void> {
	let opts = link.state.opts!
	while (!link.state.stopped) {
		let host = false
		try {
			host = await opts.tryHost()
		} catch (e) {
			// Can't serve here (say, the socket path is unusable): fail
			// the first join loudly; after that keep trying as a client.
			if (!link.state.joined) throw e
		}
		if (host) {
			let conn: Conn = opts.local((event) => {
				if (link.state.conn === conn) link.receive(event)
			})
			return link.attach(conn, 'host')
		}
		let conn = await link.dial(opts.socketPath)
		if (conn) return link.attach(conn, 'client')
		// The host is starting or has just died: try again shortly. Jitter
		// spreads out clients that all lost the same host.
		await Bun.sleep(link.retryMs() * (0.5 + Math.random()))
	}
}

// Connects to the host socket; null if nobody is listening.
function dial(path: string): Promise<Conn | null> {
	return new Promise((resolve) => {
		let socket = createConnection(path)
		let connected = false
		let conn: Conn = {
			send: (command) => {
				socket.write(ason.stringifyLine(command))
			},
			close: () => {
				socket.destroy()
			},
		}
		socket.on(
			'data',
			lines.decoder(
				(event) => {
					if (link.state.conn === conn) link.receive(event as Event)
				},
				() => {},
			),
		)
		socket.once('connect', () => {
			connected = true
			resolve(conn)
		})
		socket.on('error', () => {})
		socket.on('close', () => {
			if (!connected) resolve(null)
			else if (link.state.conn === conn) link.dropped()
		})
	})
}

function attach(conn: Conn, role: Role): void {
	let st = link.state
	if (st.stopped) return conn.close()
	st.conn = conn
	st.role = role
	st.joined = true
	st.opts!.onRole?.(role)
	for (let id of st.open) conn.send({ type: 'open', sessionId: id })
	let queued = st.queue
	st.queue = []
	for (let command of queued) conn.send(command)
}

function dropped(): void {
	let st = link.state
	st.conn = null
	st.role = null
	st.opts!.onRole?.(null)
	if (!st.stopped) void link.join()
}

function receive(event: Event): void {
	if (event.type === 'snapshot') link.state.open.add(event.sessionId)
	link.state.opts!.onEvent(event)
}

function send(command: unknown): void {
	let c = command as { type?: unknown; sessionId?: unknown }
	if (c?.type === 'close' && typeof c.sessionId === 'string') link.state.open.delete(c.sessionId)
	if (link.state.conn) link.state.conn.send(command)
	else link.state.queue.push(command)
}

function stop(): void {
	link.state.stopped = true
	let conn = link.state.conn
	link.state.conn = null
	conn?.close()
}

export const link = {
	state: createState(),
	retryMs: () => 20,
	start,
	join,
	joinLoop,
	dial,
	attach,
	dropped,
	receive,
	send,
	stop,
}
