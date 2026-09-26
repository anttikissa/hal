// Session states (tasks/j1/states.md). Every session is in exactly one
// state, which the host derives from durable history plus what it is
// doing right now, and sends in snapshots and `state` events so every
// client shows the same thing. Pure: no disk, no clock.
//
// Invariant: every state other than idle, paused and error names what
// ends it: a live request, stream or tool (running), a time (retrying)
// or a human-facing reason (blocked). A session that waits on nothing is
// a bug.

import type { HistoryRecord } from './replay.ts'

export type Phase = 'requesting' | 'streaming' | 'tools'

export type SessionState =
	// Nothing to do; the last turn completed. Ended by the user sending.
	| { type: 'idle' }
	// A turn is in progress; ended by the turn itself.
	| { type: 'running'; phase: Phase }
	// A failure the host is fixing on its own, again at `at` (ISO time).
	// Not produced yet: task tf (retries).
	| { type: 'retrying'; at: string; reason: string }
	// Needs a human: login now, approval later. Not produced yet.
	| { type: 'blocked'; reason: string }
	// The user stopped it (or the loop guard did); the turn can continue.
	| { type: 'paused'; reason?: string }
	// The turn ended on a request the host can't fix; continue retries.
	| { type: 'error'; message: string }

export type StateEvent =
	// The user sends a prompt.
	| { type: 'submit' }
	// The user continues a paused or failed turn (bare Enter).
	| { type: 'continue' }
	// A provider round starts (the first, or one after tool results).
	| { type: 'request' }
	// The round's first output arrived.
	| { type: 'stream' }
	// The round's tool calls are running.
	| { type: 'tools' }
	// Escape, Ctrl-C of the last Hal process, or the loop guard.
	| { type: 'pause'; reason?: string }
	// The turn ended: completed, or failed with `error`.
	| { type: 'end'; error?: string }

// A turn continued this many times in a row by new hosts without
// finishing a round is paused instead: it may be what kills them.
const MAX_RECOVERIES = 5

const busy = (s: SessionState) => s.type === 'running' || s.type === 'retrying' || s.type === 'blocked'

// The state after `event`, or a string saying why the event is refused
// in this state. Events the turn itself produces (request, stream,
// tools) are ignored when no turn runs: a late one after a pause.
function step(state: SessionState, event: StateEvent): SessionState | string {
	switch (event.type) {
		case 'submit':
			// Steering (task 2r) will accept a submit while busy.
			return busy(state) ? 'a turn is running' : { type: 'running', phase: 'requesting' }
		case 'continue':
			if (state.type === 'paused' || state.type === 'error') return { type: 'running', phase: 'requesting' }
			return state.type === 'idle' ? 'nothing to continue' : 'a turn is running'
		case 'request':
		case 'stream':
		case 'tools': {
			if (state.type !== 'running' && !(event.type === 'request' && state.type === 'retrying')) return state
			let phase: Phase = event.type === 'request' ? 'requesting' : event.type === 'stream' ? 'streaming' : 'tools'
			return state.type === 'running' && state.phase === phase ? state : { type: 'running', phase }
		}
		case 'pause': {
			if (!busy(state)) return 'nothing is running'
			let paused: SessionState = { type: 'paused' }
			if (event.reason !== undefined) paused.reason = event.reason
			return paused
		}
		case 'end':
			if (!busy(state)) return state
			return event.error !== undefined ? { type: 'error', message: event.error } : { type: 'idle' }
	}
}

// The state durable history alone implies. An unfinished turn (no end
// record) is running: whoever is host must be carrying it on, and a new
// host continues it. Legacy ends (cancelled: the old Escape;
// interrupted: the old restart) read as paused, so they can continue.
function fromHistory(records: HistoryRecord[]): SessionState {
	let last = records.at(-1)
	if (!last) return { type: 'idle' }
	if (last.type !== 'turn_end') return { type: 'running', phase: 'requesting' }
	if (last.status === 'completed') return { type: 'idle' }
	if (last.status === 'error') return { type: 'error', message: last.error ?? 'turn failed' }
	let paused: SessionState = { type: 'paused' }
	if (last.pauseReason !== undefined) paused.reason = last.pauseReason
	return paused
}

// How many times the turn has been continued without finishing a round
// since: `continue` records at the end of history with only assistant
// output between them. Partial output counts for nothing, as a turn
// that crashes its host mid-stream leaves some every time.
function recoveries(records: HistoryRecord[]): number {
	let n = 0
	for (let i = records.length - 1; i >= 0; i--) {
		let r = records[i]!
		if (r.type === 'continue') n++
		else if (r.type !== 'assistant') break
	}
	return n
}

// What a client sends for Enter with `text` in a session in `state`:
// a prompt, a continue (bare Enter on a paused or failed turn), nothing
// (bare Enter otherwise), or why not (the typed text stays).
function enter(sessionId: string, state: SessionState, text: string): { command?: unknown; refused?: string } {
	if (!text.trim()) return state.type === 'paused' || state.type === 'error' ? { command: { type: 'continue', sessionId } } : {}
	if (states.busy(state)) return { refused: 'a turn is running; Escape pauses it' }
	return { command: { type: 'submit', sessionId, text } }
}

// What a client sends for Escape: a pause, if anything is running.
function escape(sessionId: string, state: SessionState): unknown {
	return states.busy(state) ? { type: 'pause', sessionId } : undefined
}

// One line for the user; undefined when there is nothing to say (idle).
function describe(state: SessionState): string | undefined {
	switch (state.type) {
		case 'idle':
			return undefined
		case 'running':
			return state.phase === 'tools' ? 'running tools' : state.phase
		case 'retrying':
			return `retrying at ${state.at}: ${state.reason}`
		case 'blocked':
			return `blocked: ${state.reason}`
		case 'paused':
			return (state.reason ? `paused: ${state.reason}` : 'paused') + ' (Enter continues)'
		case 'error':
			return `error: ${state.message} (Enter retries)`
	}
}

export const states = { maxRecoveries: () => MAX_RECOVERIES, busy, step, fromHistory, recoveries, enter, escape, describe }
