// /restart on the web (task cf): bare and `local` reload this page;
// `both`, or the host's `restart` event (/restart all), marks it to
// reload once the restarted host has gone and is back.

import type { LinkState } from '../common/connection.ts'

const state: { mark?: 'marked' | 'gone' } = {}

// Typed `text`: true if it reloads the page now (the caller empties the box).
function typed(text: string): boolean {
	let t = text.trim()
	if (/^\/restart\s+both$/.test(t)) restart.mark()
	if (!/^\/restart(\s+local)?$/.test(t)) return false
	setTimeout(() => restart.reload())
	return true
}

// True if the page is reloading.
function linkChanged(link: LinkState): boolean {
	if (state.mark === 'marked' && link.type !== 'connected') state.mark = 'gone'
	if (state.mark !== 'gone' || link.type !== 'connected') return false
	restart.reload()
	return true
}

export const restart = { state, typed, linkChanged, reload: (): void => location.reload(), mark: (): void => void (state.mark = 'marked') }
