// The terminal hears the link change (task r6). Every connection brings
// the tabs; tab-start asks the host to name the tab to show: the focused
// one if any, else the start's. Before the first join nothing was lost,
// so no "host lost": a join slower than joiningMs says it is connecting
// (deciding host or peer, or dialing a remote host).

import { connection, type LinkState } from '../common/connection.ts'
import { queueEdit } from '../common/queue-edit.ts'
import { app } from './app.ts'
import { command as restart } from './commands/restart.ts'

function onState(state: LinkState): void {
	if (state.type !== 'connected') queueEdit.disconnected()
	restart.linkChanged()
	let st = app.state,
		joined = connection.state.joined
	clearTimeout(linkState.state.joining)
	st.notice = state.type === 'connected' ? undefined : joined ? 'host lost; reconnecting…' : st.notice
	if (state.type !== 'connected' && !joined)
		linkState.state.joining = setTimeout(
			() => ((st.notice = 'connecting to the host…'), app.show()),
			linkState.joiningMs,
		)
	// A new connection's host knows nothing this client watched.
	delete st.watching
	if (state.type === 'connected') {
		let tab = app.focusedTab()
		let last = tab?.id ?? st.start.last,
			cwd = tab?.cwd ?? st.start.cwd
		let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
		app.send({
			type: 'tab-start',
			...(cwd === undefined ? {} : { cwd }),
			...(last === undefined ? {} : { last }),
			...(timezone ? { timezone } : {}),
		})
		// A code for the web links this terminal prints (task e3).
		app.send({ type: 'auth', link: true })
		app.sendScreen()
	}
	app.show()
}

export const linkState = {
	state: { joining: undefined as ReturnType<typeof setTimeout> | undefined },
	joiningMs: 500,
	onState,
}
