// The in-memory stand-in for the wire (host.connect): both directions go
// through ASON, so nothing non-serializable or shared by reference
// crosses it. The history records of a snapshot or a page are the
// exception: read from disk just now (pages.ts) and held by nobody else,
// they cross as they are, since copying a big page twice blocked the
// event loop (task 7j).

import { ason } from '../common/ason.ts'
import type { Event } from '../common/protocol.ts'

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

export const wire = { copy, event }
