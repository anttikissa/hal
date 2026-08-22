// Pure selection decision for the web client's shared-state handler: which
// session should be selected after a broadcast. Kept free of Solid imports so
// it can be unit tested deterministically.
import type { SharedState } from '../../common/ipc.ts'

// How long an "open tab" request stays eligible to grab the next unseen
// session. Bounds the damage of a failed open (e.g. tab limit reached):
// without it, a much later unrelated session would steal the selection.
const config = { openRequestTtlMs: 10_000 }

const state = { requestedAt: 0 }

function markOpenRequest(): void {
	state.requestedAt = Date.now()
}

function isOpenRequestPending(): boolean {
	return state.requestedAt > 0 && Date.now() - state.requestedAt < config.openRequestTtlMs
}

function consumeOpenRequest(): void {
	state.requestedAt = 0
}

function nextSelection(shared: SharedState, current: string, previousIds: Set<string>, openPending: boolean): string {
	// Our own "open tab" command: select the session this broadcast created.
	// Broadcasts can arrive before the server finishes creating the session,
	// so only redirect once a session we have not seen before shows up.
	if (openPending) {
		const fresh = shared.sessions.find((session) => !previousIds.has(session.id))
		// Consuming on success makes the request one-shot: once satisfied,
		// later unrelated sessions cannot steal the view.
		if (fresh) {
			consumeOpenRequest()
			return fresh.id
		}
	}
	const exists = current && shared.sessions.some((session) => session.id === current)
	if (exists) return current
	// Current session was closed elsewhere; land on the first remaining one.
	return shared.sessions[0]?.id ?? ''
}

export const sessionSelection = { config, state, markOpenRequest, isOpenRequestPending, consumeOpenRequest, nextSelection }
