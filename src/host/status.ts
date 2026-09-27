// Each session's state (src/common/states.ts, tasks/j1/states.md):
// derived from history when the session is opened, then moved by
// states.step as commands and the turn go on, and broadcast when it
// changes. Only the user pauses a turn.

import { ason } from '../common/ason.ts'
import { inbox, type InboxItem } from '../common/inbox.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { states, type SessionState, type StateEvent } from '../common/states.ts'
import { history } from './history.ts'
import { host } from './host.ts'

// The session's state: what this host last made it, else what its
// history says.
function stateOf(id: string, records?: ReturnType<typeof history.readSync>): SessionState {
	return status.state.states.get(id) ?? states.fromHistory(records ?? history.readSync(id))
}

// Moves the session's state on `event`, telling followers if it changed.
// Returns why the event is refused, if it is.
function transition(id: string, event: StateEvent): string | undefined {
	let before = status.stateOf(id)
	let next = states.step(before, event)
	if (typeof next === 'string') return next
	status.state.states.set(id, next)
	if (ason.stringify(next) !== ason.stringify(before)) host.broadcast(id, { type: 'state', sessionId: id, state: next })
	return undefined
}

// The messages waiting in the session's inbox.
function inboxOf(id: string, records?: HistoryRecord[]): InboxItem[] {
	return inbox.pending(records ?? history.readSync(id))
}

// Sets the session's state to what history says, telling followers if
// it changed: after a command's question opens or closes, the session
// is as it was before (a command is not a turn). `before`: the state
// followers know, taken before the change was recorded.
function settle(id: string, before: SessionState): void {
	let next = states.fromHistory(history.readSync(id))
	status.state.states.set(id, next)
	if (ason.stringify(next) !== ason.stringify(before)) host.broadcast(id, { type: 'state', sessionId: id, state: next })
}

export const status = {
	state: {
		// Each session's state, once this host has moved it.
		states: new Map<string, SessionState>(),
	},
	stateOf,
	transition,
	inboxOf,
	settle,
}
