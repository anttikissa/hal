// Session states (tasks/j1/states.md). Every session is in exactly one
// state, which the host derives from durable history plus what it is
// doing right now, and sends in snapshots and `state` events so every
// client shows the same thing. Pure: no disk, no clock.
//
// Invariant: every state other than idle, paused and error names what
// ends it: a live request, stream or tool (running), a time (retrying)
// or a human-facing reason (blocked). A session that waits on nothing is
// a bug.
// Tasks: rqq.

import type { InboxItem } from './inbox.ts'
import type { Delivery } from './protocol.ts'
import { forms } from './forms.ts'
import { replay, type HistoryRecord } from './replay.ts'
import type { Shown } from './transcript.ts'

export type Phase = 'requesting' | 'streaming' | 'tools'

export type SessionState =
	// Nothing to do; the last turn completed. Ended by the user sending.
	| { type: 'idle' }
	// A turn is in progress; ended by the turn itself. Running tools:
	// `call` is the call running since `since` (ISO time, task wm0).
	| { type: 'running'; phase: Phase; call?: string; since?: string }
	// A failure the host is fixing on its own, again at `at` (ISO time).
	| { type: 'retrying'; at: string; reason: string }
	// Needs a human: a login, or an answer (reason `question`, the open
	// question in history: tasks/w4/forms.md).
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
	// The round's tool calls are running; `call` started at `at`.
	| { type: 'tools'; call?: string; at?: string }
	// Escape, Ctrl-C of the last Hal process, or the loop guard.
	| { type: 'pause'; reason?: string }
	// The turn ended: completed, or failed with `error`.
	| { type: 'end'; error?: string }
	// A request failed in a way the host fixes itself, trying again at `at`.
	| { type: 'retry'; at: string; reason: string }
	// A request failed in a way only a human fixes (log in), or the turn
	// asked a question (reason `question`).
	| { type: 'block'; reason: string }
	// Someone answered the open question; whoever asked runs again.
	| { type: 'answer' }

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
			// While busy it steers: the message waits in the inbox.
			return busy(state) ? state : { type: 'running', phase: 'requesting' }
		case 'continue':
			if (state.type === 'paused' || state.type === 'error') return { type: 'running', phase: 'requesting' }
			return state.type === 'idle' ? 'nothing to continue' : 'a turn is running'
		case 'request':
		case 'stream':
		case 'tools': {
			if (state.type !== 'running' && !(event.type === 'request' && (state.type === 'retrying' || state.type === 'blocked'))) return state
			let phase: Phase = event.type === 'request' ? 'requesting' : event.type === 'stream' ? 'streaming' : 'tools'
			if (event.type === 'tools' && event.call !== undefined) return { type: 'running', phase, call: event.call, ...(event.at !== undefined ? { since: event.at } : {}) }
			return state.type === 'running' && state.phase === phase ? state : { type: 'running', phase }
		}
		case 'pause': {
			if (!busy(state)) return 'nothing is running'
			let paused: SessionState = { type: 'paused' }
			if (event.reason !== undefined) paused.reason = event.reason
			return paused
		}
		case 'retry':
			return busy(state) ? { type: 'retrying', at: event.at, reason: event.reason } : state
		case 'block':
			return busy(state) ? { type: 'blocked', reason: event.reason } : state
		case 'answer':
			return state.type === 'blocked' && state.reason === 'question' ? { type: 'running', phase: 'requesting' } : 'no question is open'
		case 'end':
			if (!busy(state)) return state
			return event.error !== undefined ? { type: 'error', message: event.error } : { type: 'idle' }
	}
}

// The state durable history alone implies. A turn's open question
// blocks; a command's is not the turn's and changes nothing (nor does
// any command), and an unfinished turn (no end record) is running:
// whoever is host must be carrying it on, and a new host continues it. Legacy ends (canceled:
// the old Escape; interrupted: the old restart) read as paused, so they
// can continue.
function fromHistory(records: HistoryRecord[]): SessionState {
	let open = forms.open(records)
	if (open && !open.from) return { type: 'blocked', reason: 'question' }
	// Messages waiting in the inbox never start or end a turn.
	let last = replay.withoutCommands(records).findLast((r) => r.type !== 'inbox')
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
// output between them. A rate-limit wait ends the count: a provider
// answered and the host is waiting, not crashing. Partial output counts
// for nothing: a turn crashing mid-stream leaves some every time.
function recoveries(records: HistoryRecord[]): number {
	records = replay.withoutCommands(records)
	let n = 0
	for (let i = records.length - 1; i >= 0; i--) {
		let r = records[i]!
		if (r.type === 'continue') n++
		else if (r.type !== 'assistant' && r.type !== 'inbox') break
	}
	return n
}

// What a client sends for Enter with `text` in a session in `state`:
// a prompt (which steers a busy turn as `delivery` says, task csn), a
// continue (bare Enter on a paused, failed or waiting turn: the host
// rechecks limits and retries now), the oldest queued message sent early
// (bare Enter or Ctrl-Enter on a busy turn with `queued` ones), nothing
// (bare Enter otherwise), or why not (the text stays).
function enter(sessionId: string, state: SessionState, text: string, delivery: Delivery = 'steer', queued = false): { command?: unknown; refused?: string } {
	let busy = states.busy(state)
	if (!text.trim()) {
		if (busy && queued && delivery !== 'queue') return { command: { type: 'submit', sessionId, text: delivery === 'steer' ? '/queue now' : '/queue next' } }
		return state.type === 'paused' || state.type === 'error' || state.type === 'retrying' ? { command: { type: 'continue', sessionId } } : {}
	}
	return { command: delivery === 'queue' || (delivery === 'soft-steer' && busy) ? { type: 'submit', sessionId, text, delivery } : { type: 'submit', sessionId, text } }
}

// Whether undo on an empty prompt may take back a message sent early
// from the queue (task csn): one of the user's waits to interject.
function promoted(items: InboxItem[]): boolean {
	return items.some((m) => (m.delivery === 'next-round') && m.from === undefined && m.origin !== 'model')
}

// What a client sends for Escape: a pause, if anything is running.
function escape(sessionId: string, state: SessionState): unknown {
	return states.busy(state) ? { type: 'pause', sessionId } : undefined
}

// A wait in words: 12s, 4m 10s, 3h 5m.
function duration(ms: number): string {
	let s = Math.ceil(ms / 1000)
	if (s < 60) return `${s}s`
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// One line for the user in plain words, never a state or phase name:
// what the session is doing or what the user can do about it. Undefined
// when there is nothing to add: idle, or blocked on a question (the
// question itself is on screen). With `now` (epoch ms) a retry says how long until it; without, the
// time of day it happens, which never goes stale. `items`, the
// transcript so far, sharpens a running turn: whether the model thinks
// or writes, and which tools still run.
function describe(state: SessionState, now?: number, items: readonly Shown[] = []): string | undefined {
	switch (state.type) {
		case 'idle':
			return undefined
		case 'running':
			return states.doing(state.phase, items)
		case 'retrying':
			if (now === undefined) return `retrying at ${new Date(state.at).toLocaleTimeString()} (${state.reason})`
			let left = Date.parse(state.at) - now
			return `retrying ${left > 0 ? `in ${duration(left)}` : 'now'} (${state.reason})`
		case 'blocked':
			// Any other reason is already the words the user acts on.
			return state.reason === 'question' ? undefined : state.reason
		case 'paused':
			return (state.reason ? `paused: ${state.reason}` : 'paused') + ' (Enter continues)'
		case 'error':
			return `error: ${state.message} (Enter retries)`
	}
}

// A running turn in a word or two. Until the first streamed byte the
// model has not started thinking, so it is only 'processing'; after it,
// 'thinking' while thinking text streams, else 'writing'.
function doing(phase: Phase, items: readonly Shown[]): string {
	if (phase === 'requesting') return 'processing'
	if (phase === 'streaming') return items.at(-1)?.type === 'thinking' ? 'thinking' : 'writing'
	let done = new Set(items.flatMap((i) => (i.type === 'tool-result' ? [i.id] : [])))
	let names = items.flatMap((i) => (i.type === 'tool' && !done.has(i.id) ? [i.name] : []))
	return names.length ? `running ${names.join(', ')}` : 'running tools'
}

export const states = { maxRecoveries: () => MAX_RECOVERIES, busy, step, fromHistory, recoveries, enter, promoted, escape, describe, doing }
