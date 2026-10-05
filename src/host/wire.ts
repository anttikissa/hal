// The in-memory stand-in for the wire (host.connect): both directions go
// through ASON, so nothing non-serializable or shared by reference
// crosses it. The history records of a snapshot or a page are the
// exception: read from disk just now (pages.ts) and held by nobody else,
// they cross as they are, since copying a big page twice blocked the
// event loop (task 7j).

import { ason } from '../common/ason.ts'
import type { Event } from '../common/protocol.ts'
import type { ClientInfo } from './clients.ts'
import { host } from './host.ts'

function copy<T>(value: T): T {
	return ason.parse(ason.stringify(value, 'short')) as T
}

function event(e: Event): Event {
	if (e.type === 'history') return { ...wire.copy({ ...e, records: [] }), records: e.records }
	if (e.type !== 'snapshot') return wire.copy(e)
	let { history, earlier, ...rest } = e.snapshot
	let snapshot = { ...wire.copy(rest), history, ...(earlier ? { earlier } : {}) }
	return { ...e, snapshot }
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

export const wire = { adapt, copy, event }
