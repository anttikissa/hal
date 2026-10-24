// /restart on the web (task cf): `local` reloads this page (bare
// means all and goes to the host);
// `both`, or the host's `restart` event (/restart all), marks it to
// reload once the restarted host has gone and is back. A `both` the
// host held for flagged calls (restart-ask, task ker) is unmarked; the
// dialog's Restart anyway marks it again (app.modalKey).

import { connection, type LinkState } from '../common/connection.ts'

const state: { mark?: 'marked' | 'gone'; goneAt?: number } = {}

// Typed `text`: true if it reloads the page now (the caller empties the box).
function typed(text: string): boolean {
	let t = text.trimEnd()
	if (/^\/restart\s+both$/.test(t)) restart.mark()
	if (!/^\/restart\s+local$/.test(t)) return false
	setTimeout(() => restart.reload())
	return true
}

// True if the page is reloading.
function linkChanged(link: LinkState): boolean {
	if (state.mark === 'marked' && link.type !== 'connected') {
		state.mark = 'gone'
		state.goneAt = Date.now()
	}
	// A restarted host is back within a second: retry at the base pace,
	// without backoff, for the first 30 s.
	if (state.mark === 'gone' && link.type === 'disconnected' && Date.now() - state.goneAt! < 30_000)
		connection.state.failures = 0
	if (state.mark !== 'gone' || link.type !== 'connected') return false
	restart.reload()
	return true
}

export const restart = {
	state,
	typed,
	linkChanged,
	reload: (): void => location.reload(),
	mark: (): void => void (state.mark = 'marked'),
}
