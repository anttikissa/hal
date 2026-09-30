// /restart in the terminal. Bare or `local` (Ctrl-R, caught by the
// emergency path) exits with the restart code, which ./run answers by
// starting again. `both`, or the host's `restart` event (/restart all),
// marks this client to restart as soon as its host goes: the next link
// change after the mark is the host leaving.

import { terminal } from '../terminal.ts'

const state = { withHost: false }

export const command = {
	run: (): void => terminal.restart(),
	state,
	withHost: (): void => void (state.withHost = true),
	linkChanged: (): void => void (state.withHost && terminal.restart()),
}
