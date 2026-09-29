// Each session's state (src/common/states.ts, tasks/j1/states.md):
// derived from history when the session is opened, then moved by
// states.step as commands and the turn go on, and broadcast when it
// changes. Only the user pauses a turn.

import { ason } from '../common/ason.ts'
import { inbox, type InboxItem } from '../common/inbox.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { states, type SessionState, type StateEvent } from '../common/states.ts'
import { host } from './host.ts'
import { pages } from './pages.ts'

// The session's state: what this host last made it, else what its
// history says (the few records that decide it: pages.essentials), kept
// while the history does not grow (the tab bar asks for every tab's).
function stateOf(id: string, records?: HistoryRecord[]): SessionState {
	let moved = status.state.states.get(id)
	if (moved || records) return moved ?? states.fromHistory(records!)
	let derived = status.state.derived.get(id)
	if (derived?.size !== pages.marks(id).size) return status.derive(id, pages.essentials(id))
	return { ...derived.state }
}

// Keeps the state `essentials` (pages.essentials, just read) say.
function derive(id: string, essentials: HistoryRecord[]): SessionState {
	let state = states.fromHistory(essentials)
	status.state.derived.set(id, { size: pages.marks(id).size, state })
	return { ...state }
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
	return inbox.pending(records ?? pages.essentials(id))
}

export const status = {
	state: {
		// Each session's state, once this host has moved it.
		states: new Map<string, SessionState>(),
		// Each session's state as its history says, and its size then.
		derived: new Map<string, { size: number; state: SessionState }>(),
	},
	stateOf,
	derive,
	transition,
	inboxOf,
}
