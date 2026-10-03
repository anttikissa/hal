// The terminal's (and a peer's) transport to its home's host, whoever
// that is, for the common connection (src/common/connection.ts). Each
// attempt becomes host if nobody is, and then talks to the host in this
// process through the same protocol (in-process); else it connects to
// the host socket (Unix socket, line-delimited ASON).

import { createConnection } from 'net'
import { connection, type Conn, type LinkState, type Transport } from '../common/connection.ts'
import { lines } from '../common/lines.ts'
import type { Event } from '../common/protocol.ts'

export type LinkOptions = {
	socketPath: string
	// Takes over as host if nobody holds the host lock; true on success.
	tryHost: () => Promise<boolean>
	// A connection to the host in this process.
	local: (deliver: (event: Event) => void) => Conn
	onEvent: (event: Event) => void
	onState?: (state: LinkState) => void
}

function transport(opts: Omit<LinkOptions, 'onEvent' | 'onState'>): Transport {
	return {
		connect: async (on) => {
			let host = false
			try {
				host = await opts.tryHost()
			} catch (e) {
				// Can't serve here (say, the socket path is unusable): fail
				// the first join loudly; after that keep trying as a client.
				if (!connection.state.joined) throw e
			}
			if (host) return { conn: opts.local(on.event), role: 'host' }
			let conn = await link.dial(opts.socketPath, on)
			return conn && { conn, role: 'client' }
		},
	}
}

// Connects to the host socket; null if nobody is listening.
function dial(path: string, on: { event(event: Event): void; dropped(): void }): Promise<Conn | null> {
	return new Promise((resolve) => {
		let socket = createConnection(path)
		let connected = false
		socket.on(
			'data',
			lines.decoder(
				(event) => on.event(event as Event),
				() => {},
			),
		)
		socket.once('connect', () => {
			connected = true
			socket.write(lines.encode({ type: 'hello', pid: process.pid }))
			resolve({ send: (command) => void socket.write(lines.encode(command)), close: () => void socket.destroy() })
		})
		socket.on('error', () => {})
		socket.on('close', () => (connected ? on.dropped() : resolve(null)))
	})
}

// Joins, resolving once connected (as host or client). Losing the host
// retries fast: another process is about to take over.
function start(opts: LinkOptions): Promise<void> {
	let startOpts: Parameters<typeof connection.start>[0] = { transport: link.transport(opts), onEvent: opts.onEvent, baseMs: link.retryMs, maxMs: 1000 }
	if (opts.onState) startOpts.onState = opts.onState
	return connection.start(startOpts)
}

export const link = {
	retryMs: 20,
	transport,
	dial,
	start,
}
