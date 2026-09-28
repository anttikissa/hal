/// <reference lib="dom" />
// Which of the host's tabs (task 0a) this page shows, named by the
// address (router.ts): the tabs as they arrive, switching (following
// the new tab's session, no longer the old one; each keeps its draft
// and scroll place), Back and Forward, and the tab keys (shortcuts.ts).
// The state lives in app.state (tabs, shown, asked).

import { backfill } from '../common/backfill.ts'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import { recall } from '../common/recall.ts'
import type { Event, Tab } from '../common/protocol.ts'
import { app } from './app.ts'
import type { KeyInput } from './keys.ts'
import { router } from './router.ts'
import { push } from './push.ts'
import { scroll } from './scroll.ts'
import { shortcuts, type TabAction } from './shortcuts.ts'
import { view } from './view.ts'

// A hidden tab receives live updates but must not change the visible DOM.
function hiddenEvent(event: Event): void {
	let st = app.state
	if (!('sessionId' in event) || !event.sessionId) return
	if (st.tabs.some((tab) => tab.id === event.sessionId)) {
		if (event.type === 'snapshot') backfill.onSnapshot(st.older, event)
		st.cached.set(event.sessionId, view.onEvent(st.cached.get(event.sessionId) ?? {}, event))
	}
	if (st.loading === event.sessionId && (event.type === 'snapshot' || event.type === 'rejected')) {
		delete st.loading
		tabs.backgroundStep()
	}
}

// After first paint, open the nearest neighbour, then the next upon its
// snapshot. Never poll or cap the pace after startup.
function backgroundStep(): void {
	let st = app.state
	if (!st.painted || st.loading || st.timer || !connection.connected()) return
	let id = backfill.nearby(st.tabs.map((tab) => tab.id), st.shown ?? '').find((id) => !st.background.has(id))
	if (!id) return
	st.timer = setTimeout(() => {
		delete st.timer
		if (!st.tabs.some((tab) => tab.id === id) || st.shown === id) return tabs.backgroundStep()
		st.background.add(id)
		st.loading = id
		connection.send({ type: 'open', sessionId: id })
	}, 0)
}

// Tab events, and a late snapshot of a tab shown before: handled here
// (true), or left to app.onEvent.
function onEvent(event: Event): boolean {
	let st = app.state
	if (event.type === 'tabs') tabs.onTabs(event.tabs)
	else if (event.type === 'go') {
		if (st.shown === event.sessionId && st.tabs.some((tab) => tab.id === event.tab)) tabs.show(event.tab, false)
	}
	else if (event.type === 'ack' && st.asked.delete(event.id) && event.tab) tabs.show(event.tab, false)
	else if (event.type === 'snapshot' && st.shown && event.sessionId !== st.shown) return false
	else return false
	return true
}

// Each connection brings the tabs; tab-start picks the one to show.
function connected(): void {
	let last = app.state.shown ?? router.parse(router.href()) ?? router.store.load()
	connection.send(last ? { type: 'tab-start', last } : { type: 'tab-start' })
}

// A tab key: true if it was one (and is done).
function key(e: KeyInput): boolean {
	let a = shortcuts.action(e, tabs.mac())
	if (a) tabs.tabAction(a)
	return !!a
}

// The tabs changed. If the shown one is gone (or none shows yet), the
// page lands on another, rewriting the address.
function onTabs(list: Tab[]): void {
	let st = app.state
	let before = st.tabs
	st.tabs = list
	for (let id of st.cached.keys()) if (!list.some((tab) => tab.id === id)) {
		st.cached.delete(id)
		st.background.delete(id)
		connection.send({ type: 'close', sessionId: id })
	}
	let target = router.pick(list, st.shown ?? router.parse(router.href()), before)
	if (target && target !== st.shown) return tabs.show(target, true)
	tabs.seen()
	app.changed()
}

// Show tab `id`, the address naming it: a new history entry, or with
// `replace` (a tab the page landed on) the current one rewritten.
function show(id: string, replace: boolean): void {
	let st = app.state
	router.go(id, replace)
	if (id === st.shown) return
	if (st.shown) {
		scroll.save(st.shown)
		if (st.tabs.some((tab) => tab.id === st.shown)) st.cached.set(st.shown, st.view)
		else {
			st.background.delete(st.shown)
			connection.send({ type: 'close', sessionId: st.shown })
		}
		delete st.target
	}
	st.shown = id
	st.view = st.cached.get(id) ?? {}
	st.cached.delete(id)
	st.text = recall.shown(id) ?? drafts.text(id)
	router.store.save(id)
	if (!st.background.has(id)) {
		st.background.add(id)
		connection.send({ type: 'open', sessionId: id })
	}
	push.visibility(id)
	tabs.seen()
	app.changed()
	app.backgroundStep()
}

// Back or Forward: the tab the address names, if it is one.
function onPopState(): void {
	let st = app.state
	if (st.tabs.length) tabs.show(router.pick(st.tabs, router.parse(router.href()))!, true)
}

// The shown tab no longer wants attention.
function seen(): void {
	if (typeof document !== 'undefined' && (document.visibilityState !== 'visible' || !document.hasFocus())) return
	let { tabs, shown } = app.state
	if (tabs.find((t) => t.id === shown)?.attention) connection.send({ type: 'tab-seen', sessionId: shown })
}

// A new tab in the shown tab's cwd, after it; it shows once made.
function newTab(): void {
	let tab = app.state.tabs.find((t) => t.id === app.state.shown)
	if (!tab) return app.setNotice('no tab to open one beside yet')
	let id = connection.nextId()
	app.state.asked.add(id)
	connection.send({ type: 'tab-new', id, cwd: tab.cwd, after: tab.id })
}

function closeTab(id: string): void {
	connection.send({ type: 'tab-close', sessionId: id })
}

function tabAction(a: TabAction): void {
	let { tabs: list, shown } = app.state
	if (a.type === 'new') return tabs.newTab()
	if (a.type === 'close') return shown ? tabs.closeTab(shown) : undefined
	let at = list.findIndex((t) => t.id === shown)
	let to = a.type === 'go' ? a.index : (at + (a.type === 'next' ? 1 : -1) + list.length) % list.length
	let tab = list[to]
	if (tab) tabs.show(tab.id, false)
}

export const tabs = {
	hiddenEvent,
	backgroundStep,
	onEvent,
	connected,
	key,
	onTabs,
	show,
	onPopState,
	seen,
	newTab,
	closeTab,
	tabAction,
	// Whether Ctrl-T/W/N/P are the page's (shortcuts.ts).
	mac: (): boolean => /Mac|iPhone|iPad/.test(navigator.platform),
}
