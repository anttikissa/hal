// The browser's transport to the host for the common connection
// (src/common/connection.ts): one WebSocket at /ws, each message one
// ASON command or event. The host closes it with code 4000 when the
// page was built from other code than the host runs: the page reloads.

import { ason } from '../common/ason.ts'
import { connection, type Conn, type LinkState, type Transport } from '../common/connection.ts'
import type { Event } from '../common/protocol.ts'

// The part of a WebSocket this uses, so tests can pass a fake.
export type Socket = {
	send(data: string): void
	close(): void
	onopen: ((ev?: any) => void) | null
	onmessage: ((m: any) => void) | null
	onclose: ((ev?: any) => void) | null
}

export type LinkOptions = {
	dial: () => Socket
	// The host runs other code than this page: load it again.
	reload: () => void
	onEvent: (event: Event) => void
	onState?: (state: LinkState) => void
}

function transport(dial: () => Socket, reload: () => void = () => {}): Transport {
	return {
		connect: (on) =>
			new Promise((resolve) => {
				let socket = dial()
				let open = false
				let conn: Conn = { send: (command) => socket.send(ason.stringify(command, 'short')), close: () => socket.close() }
				socket.onopen = () => {
					open = true
					resolve({ conn, role: 'client' })
				}
				socket.onmessage = (m) => {
					let event: Event
					try {
						event = ason.parse(String(m.data)) as Event
					} catch {
						return
					}
					on.event(event)
				}
				socket.onclose = (ev) => {
					if (ev?.code === 4000) reload()
					if (open) on.dropped()
					else resolve(null)
				}
			}),
	}
}

// Connects, and reconnects with backoff whenever the socket drops.
function start(opts: LinkOptions): void {
	let startOpts: Parameters<typeof connection.start>[0] = {
		transport: link.transport(opts.dial, opts.reload),
		onEvent: opts.onEvent,
		baseMs: link.baseMs(),
		maxMs: link.maxDelayMs(),
	}
	if (opts.onState) startOpts.onState = opts.onState
	void connection.start(startOpts)
}

export const link = { baseMs: () => 250, maxDelayMs: () => 10_000, transport, start }
