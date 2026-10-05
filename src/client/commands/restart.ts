// /restart in the terminal. Bare or `local` (Ctrl-R, caught by the
// emergency path) exits with the restart code, which ./run answers by
// starting again. `both`, or the host's `restart` event (/restart all),
// marks this client to restart as soon as its host goes: the next link
// change after the mark is the host leaving.
//
// The restart dialog (task ker), opened with `open` (app.open): the host
// held /restart <scope> for flagged calls (restart-ask), or (`now`)
// Ctrl-R in the host's terminal found some. A `both` this client typed
// follows the host only on Restart anyway.

import { modals, type FlaggedCall, type ModalAction, type ModalState } from '../../common/modals.ts'
import { terminal } from '../terminal.ts'

type Open = (modal: ModalState, submit: (action: Extract<ModalAction, { type: 'submit' }>, modal: ModalState) => unknown) => void

const state = { withHost: false }

export const command = {
	run: (): void => terminal.restart(),
	state,
	withHost: (): void => void (state.withHost = true),
	linkChanged: (): void => void (state.withHost && terminal.restart()),
	ask,
}

// With no flagged calls, `now` restarts at once.
function ask(event: { scope: string; calls: FlaggedCall[]; sessionId?: string }, open: Open, now?: () => void): void {
	if (!event.calls.length) return now?.()
	state.withHost = false
	open(modals.restart(event.scope, event.calls), (action, modal) => {
		if (action.item !== 1) return undefined
		if (now) return now()
		if (event.scope === 'both') state.withHost = true
		return modals.restartCommand(modal, action, event.sessionId ?? '')
	})
}
