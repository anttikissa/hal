/// <reference lib="dom" />
// The address: /<sessionId> names the tab the page shows, so a tab can
// be linked and Back/Forward move between tabs. Choosing a tab pushes a
// history entry; landing on a tab the page did not ask for (the tab
// closed, an unknown id, no id) replaces the entry instead. One flat
// route over a WebSocket that already brings the data: no router
// library (tasks/1b).
//
// The address bar and localStorage are reached through href, write and
// store, so tests drive the router without a DOM.

import type { Tab } from '../common/protocol.ts'
import { session } from '../common/session.ts'

const storeKey = 'hal-tab'

function href(): string {
	return location.href
}

function write(url: string, replace: boolean): void {
	if (replace) history.replaceState(null, '', url)
	else history.pushState(null, '', url)
}

// The tab shown last, remembered across visits.
const store = {
	load: (): string | undefined => {
		try {
			return localStorage.getItem(storeKey) ?? undefined
		} catch {
			return undefined
		}
	},
	save: (id: string): void => {
		try {
			localStorage.setItem(storeKey, id)
		} catch {
			// Storage disabled: the first tab it is, next time.
		}
	},
}

// The session id the address names, if it names one.
function parse(url: string): string | undefined {
	let id = new URL(url).pathname.slice(1)
	return session.isId(id) ? id : undefined
}

// Whether the address is the app's own (/ or /<id>), not a file such
// as /image/<name> that shows the login gate only until logged in.
function isApp(url: string): boolean {
	let path = new URL(url).pathname
	return path === '/' || router.parse(url) !== undefined
}

function format(id: string): string {
	return `/${id}`
}

// The tab to show when `wanted` (what the address or page asked for)
// may not be open: itself if it is; for a tab that just closed (in
// `before`), its neighbor; else the tab shown last, else the first.
function pick(tabs: Tab[], wanted: string | undefined, before: Tab[] = []): string | undefined {
	let ids = tabs.map((t) => t.id)
	if (wanted && ids.includes(wanted)) return wanted
	let was = wanted ? before.findIndex((t) => t.id === wanted) : -1
	if (was >= 0 && ids.length) return ids[Math.min(was, ids.length - 1)]
	let last = router.store.load()
	return last && ids.includes(last) ? last : ids[0]
}

// The address now names `id` (and `block`, task 4qh): a new history
// entry, or with `replace` the current one rewritten. Nothing if it
// already does.
function go(id: string, replace: boolean, block?: string): void {
	let url = new URL(router.href())
	if (router.parse(url.href) === id && (!block || url.hash === `#${block}`)) return
	router.write(`${router.format(id)}${url.search}${block ? `#${block}` : ''}`, replace)
}

export const router = { href, write, store, parse, isApp, format, pick, go }
