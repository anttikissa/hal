/// <reference lib="dom" />
// Which of the host's tabs (task 0a) this page shows, named by the
// address (router.ts): the tabs as they arrive, switching (following
// the new tab's session, no longer the old one; each keeps its draft
// and scroll place), Back and Forward, and the tab keys (key()).
// The state lives in app.state (tabs, shown, asked).

import { backfill } from '../common/backfill.ts'
import { follow } from '../common/follow.ts'
import { commandList } from '../common/commands/list.ts'
import { markdown } from '../common/markdown.ts'
import { connection } from '../common/connection.ts'
import { queueEdit } from '../common/queue-edit.ts'
import { queuedPrompt } from './queue-edit.ts'
import { drafts } from '../common/drafts.ts'
import { notices } from '../common/notices.ts'
import { recall } from '../common/recall.ts'
import type { Event, Tab } from '../common/protocol.ts'
import { tabKeys } from '../common/tab-keys.ts'
import { app } from './app.ts'
import type { KeyInput } from './keys.ts'
import { router } from './router.ts'
import { push } from './push.ts'
import { scroll } from './scroll.ts'
import { diagnostics } from './diagnostics.ts'
import { view } from './view.ts'

// A hidden tab receives live updates but must not change the visible DOM.
function hiddenEvent(event: Event): void {
	let st = app.state
	if (!('sessionId' in event) || !event.sessionId) return
	if (st.background.has(event.sessionId)) {
		if (event.type === 'snapshot') backfill.onSnapshot(st.older, event)
		st.cached.set(event.sessionId, view.onEvent(st.cached.get(event.sessionId) ?? {}, event))
	}
	if (st.loading === event.sessionId && (event.type === 'snapshot' || event.type === 'rejected')) {
		delete st.loading
		tabs.backgroundStep()
	}
}

// After first paint, follow the tabs it may show next (common/follow.ts),
// one open at a time upon the previous snapshot, and close the others
// unless busy.
function backgroundStep(): void {
	let st = app.state
	if (!st.painted || st.loading || st.timer || !connection.connected() || !st.shown) return
	let ids = st.tabs.map((tab) => tab.id)
	let wanted = follow.wanted(ids, st.shown, st.strip ?? { start: 0, end: 0 }, st.pressed)
	for (let id of st.background) if (id !== st.shown && !wanted.includes(id) && !tabs.busy(id)) tabs.unfollow(id)
	let id = wanted.find((id) => !st.background.has(id))
	if (!id) return
	st.timer = setTimeout(() => {
		delete st.timer
		if (!st.tabs.some((tab) => tab.id === id) || st.shown === id) return tabs.backgroundStep()
		st.background.add(id)
		st.loading = id
		connection.send({ type: 'open', sessionId: id })
	}, 0)
}

// A tab that stays followed: what closing it would lose, or a reader
// away from its bottom, whose place a fresh tail would not hold.
function busy(id: string): boolean {
	let view = app.state.cached.get(id)
	let place = scroll.state.places.get(id)
	return follow.busy(id) || !!view?.editing || !!view?.form || (!!place && 'top' in place)
}

function unfollow(id: string): void {
	let st = app.state
	st.background.delete(id)
	st.cached.delete(id)
	st.older.delete(id)
	connection.send({ type: 'close', sessionId: id })
}

// A tab under the pointer opens before the click lands.
function press(id: string): void {
	let st = app.state
	st.pressed = id
	if (id !== st.shown && !st.background.has(id) && connection.connected()) {
		st.background.add(id)
		connection.send({ type: 'open', sessionId: id })
	}
	tabs.backgroundStep()
}

// The strip's tabs start..end-1 are on screen.
function onScreen(start: number, end: number): void {
	let st = app.state
	if (st.strip?.start === start && st.strip.end === end) return
	st.strip = { start, end }
	tabs.backgroundStep()
}

// Tab events, and a late snapshot of a tab shown before: handled here
// (true), or left to app.onEvent.
function onEvent(event: Event): boolean {
	let st = app.state
	if (event.type === 'tabs') {
		if (event.sessions) markdown.state.sessions = new Set(event.sessions)
		tabs.onTabs(event.tabs)
	} else if (event.type === 'rejected' && event.id && st.asked.delete(event.id)) {
		delete st.landing
		tabs.onTabs(st.tabs)
		return false
	} else if (event.type === 'go') {
		if (st.shown === event.sessionId && st.tabs.some((tab) => tab.id === event.tab)) {
			tabs.show(event.tab, false, event.block)
			if (event.block) app.aim()
		}
	} else if (event.type === 'ack' && st.asked.delete(event.id) && event.tab) tabs.show(event.tab, false)
	else if (event.type === 'notice') {
		notices.add(notices.fromEvent(event))
		push.noticed()
	} else if (event.type === 'snapshot' && st.shown && event.sessionId !== st.shown) return false
	else return false
	return true
}

// Each connection brings the tabs; tab-start picks the one to show.
function connected(): void {
	let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
	let addressed = router.parse(router.href())
	if (!app.state.shown && addressed) {
		app.state.landing = addressed
		let id = connection.nextId()
		app.state.asked.add(id)
		connection.send({ type: 'tab-resume', id, sessionId: addressed, timezone })
	} else {
		let last = app.state.shown ?? router.store.load()
		connection.send(last ? { type: 'tab-start', last, timezone } : { type: 'tab-start', timezone })
	}
}

// A tab key, as in the terminal: switching (common/tab-keys.ts), or the
// key of /new, /close or /resume (common/commands/list.ts), sent
// unrecorded. Keys the browser keeps (commandList.onWeb) stay its own.
// Alt-digits match by physical key, since Alt types symbols on macOS.
// True if it was one (and is done).
function key(e: KeyInput): boolean {
	if (e.isComposing) return false
	let digit = e.altKey ? /^Digit([0-9])$/.exec(e.code ?? '')?.[1] : undefined
	let b = { key: digit ?? e.key.toLowerCase(), shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, cmd: e.metaKey }
	let label = `${b.shift ? 'shift-' : ''}${b.alt ? 'alt-' : ''}${b.ctrl ? 'ctrl-' : ''}${b.cmd ? 'cmd-' : ''}${b.key}`
	if (!commandList.onWeb(label, tabs.mac())) return false
	let { tabs: list, shown } = app.state
	let r =
		shown === undefined
			? undefined
			: tabKeys.key(
					b,
					shown,
					list.map((t) => t.id),
				)
	if (r) {
		if (r.focus !== undefined && r.focus !== shown) tabs.show(r.focus, false)
		return true
	}
	let name = commandList.byKey(b)?.name
	if (name === 'new') tabs.newTab()
	else if (name === 'close') {
		if (shown) tabs.closeTab(shown)
	} else if (name === 'resume') tabs.resume()
	else return false
	return true
}

// The tabs changed. If the shown one is gone (or none shows yet), the
// page lands on another, rewriting the address.
function onTabs(list: Tab[]): void {
	let st = app.state
	let before = st.tabs
	st.tabs = list
	for (let t of list) markdown.state.sessions.add(t.id)
	if (st.landing && !list.some((t) => t.id === st.landing)) return
	delete st.landing
	for (let id of st.cached.keys())
		if (!list.some((tab) => tab.id === id)) {
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
function show(id: string, replace: boolean, block?: string): void {
	let st = app.state
	router.go(id, replace, block)
	if (id === st.shown) return
	if (st.shown) {
		scroll.save(st.shown)
		if (st.tabs.some((tab) => tab.id === st.shown))
			st.cached.set(st.shown, st.view.editing ? { ...st.view, editText: st.text } : st.view)
		else {
			st.background.delete(st.shown)
			connection.send({ type: 'close', sessionId: st.shown })
		}
		delete st.target
	}
	st.shown = id
	diagnostics.load('selected', performance.now(), st.tabs.findIndex((t) => t.id === id) + 1)
	let { editText, ...cached } = st.cached.get(id) ?? {}
	st.view = cached
	st.cached.delete(id)
	// An edit in progress keeps its text (task dg).
	st.text = queueEdit.editing(id)
		? queueEdit.text(id)
		: cached.editing && editText !== undefined
			? editText
			: (recall.shown(id) ?? drafts.text(id))
	queuedPrompt.sync()
	router.store.save(id)
	if (!st.background.has(id)) {
		st.background.add(id)
		diagnostics.load('requested')
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

// Reopens the last closed tab; it shows once reopened.
function resume(): void {
	let id = connection.nextId()
	app.state.asked.add(id)
	connection.send({ type: 'tab-resume', id })
}

export const tabs = {
	hiddenEvent,
	backgroundStep,
	busy,
	unfollow,
	press,
	onScreen,
	onEvent,
	connected,
	key,
	onTabs,
	show,
	onPopState,
	seen,
	newTab,
	closeTab,
	resume,
	// Whether the browser gives Ctrl-T and the like to the page.
	mac: (): boolean => /Mac|iPhone|iPad/.test(navigator.platform),
}
