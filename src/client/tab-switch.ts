// Tab switching in the terminal client: the host's tabs as they
// arrive, showing one (following its session, no longer the old one's;
// each keeps its client state meanwhile) and the tab keys. The state
// lives in app.state (tabs, focus, asked, hidden).

import { backfill } from '../common/backfill.ts'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import { prompt } from '../common/prompt.ts'
import type { Event, Tab } from '../common/protocol.ts'
import { transcript } from '../common/transcript.ts'
import { recall } from '../common/recall.ts'
import { app, type AppState } from './app.ts'
import type { KeyEvent } from './keys.ts'
import { tabs, type Focus } from './tabs.ts'

// What each tab keeps while another is shown.
export type TabView = Pick<AppState, 'transcript' | 'prompt' | 'notice' | 'form' | 'editing'>
const tabFields = ['transcript', 'prompt', 'notice', 'form', 'editing'] as const

// A hidden tab's live events update its cache without repainting the UI.
function hiddenEvent(event: Event): void {
	let st = app.state
	if (!('sessionId' in event) || !event.sessionId) return
	if (st.tabs.some((tab) => tab.id === event.sessionId)) {
		if (event.type === 'snapshot') backfill.onSnapshot(st.older, event)
		let kept = st.hidden.get(event.sessionId) ?? { prompt: prompt.empty() }
		kept.transcript = transcript.fold(kept.transcript, event)
		if (event.type === 'snapshot' && kept.transcript) kept.prompt = { text: drafts.text(event.sessionId), cursor: drafts.text(event.sessionId).length }
		st.hidden.set(event.sessionId, kept)
	}
	if (st.loading === event.sessionId && (event.type === 'snapshot' || event.type === 'rejected')) {
		delete st.loading
		tabSwitch.backgroundStep()
	}
}

// Open one tail per event-loop slice, after the focused snapshot has
// painted. The next tail starts after the previous snapshot arrives.
function backgroundStep(): void {
	let st = app.state
	if (!st.painted || st.loading || st.timer || !connection.connected()) return
	let id = backfill.nearby(st.tabs.map((tab) => tab.id), st.focus.tab ?? '').find((id) => !st.background.has(id))
	if (!id) return
	st.timer = setTimeout(() => {
		delete st.timer
		if (!st.tabs.some((tab) => tab.id === id) || st.focus.tab === id) return tabSwitch.backgroundStep()
		st.background.add(id)
		st.loading = id
		app.send({ type: 'open', sessionId: id })
	}, 0)
}

function focusedTab(): Tab | undefined {
	return app.state.tabs.find((t) => t.id === app.state.focus.tab)
}

// The host's tabs changed, or named the tab this client asked for.
function onTabs(list: Tab[]): void {
	let st = app.state
	let old = st.tabs.map((t) => t.id)
	let ids = list.map((t) => t.id)
	st.tabs = list
	let asked = st.asked
	if (asked !== undefined && ids.includes(asked)) delete st.asked
	for (let id of st.hidden.keys()) if (!ids.includes(id)) {
		st.hidden.delete(id)
		st.background.delete(id)
		app.send({ type: 'close', sessionId: id })
	}
	app.focusOn(tabs.focus(old, ids, st.focus, asked))
	app.show()
	app.backgroundStep()
}

// Shows `focus`: the tab left keeps its client state and is no longer
// followed, the tab shown is followed and its state comes back. A modal
// closes. A tab shown that wants attention is told seen.
function focusOn(focus: Focus): void {
	let st = app.state
	let from = st.focus.tab
	st.focus = focus
	if (focus.tab !== from) {
		// Typed before any tab was shown: it joins the draft.
		let early = from === undefined ? st.prompt.text : ''
		if (from !== undefined) {
			if (st.tabs.some((tab) => tab.id === from)) {
				let kept = {} as TabView
				for (let f of tabFields) if (st[f] !== undefined) Object.assign(kept, { [f]: st[f] })
				st.hidden.set(from, kept)
			} else {
				st.background.delete(from)
				app.send({ type: 'close', sessionId: from })
			}
		}
		for (let f of tabFields) delete st[f]
		let back = focus.tab === undefined ? undefined : st.hidden.get(focus.tab)
		Object.assign(st, { prompt: prompt.empty() }, back)
		delete st.modal
		delete st.choices
		delete st.onModal
		delete st.onModalKey
		if (focus.tab !== undefined) {
			st.hidden.delete(focus.tab)
			if (!back) drafts.join(focus.tab, early)
			if (!back) app.setPrompt(recall.shown(focus.tab) ?? drafts.text(focus.tab))
			if (!st.background.has(focus.tab)) {
				st.background.add(focus.tab)
				app.send({ type: 'open', sessionId: focus.tab })
			} else if (back?.transcript && !st.older.get(focus.tab)?.asked) {
				let command = st.older.get(focus.tab)?.older !== undefined && backfill.next(st.older, focus.tab)
				if (command) setTimeout(app.send, 0, command)
			}
		}
	}
	let tab = app.focusedTab()
	if (tab) app.focused(tab)
	if (tab?.attention) app.send({ type: 'tab-seen', sessionId: tab.id })
}

// Tab keys: next, previous, go to 1-10. True if handled.
function tabKey(k: KeyEvent): boolean {
	let tab = app.focusedTab()
	let r = tab && tabs.key(k, tab, app.state.tabs.map((t) => t.id))
	if (!r) return false
	if (r.focus !== undefined && r.focus !== tab!.id) app.focusOn({ tab: r.focus })
	return true
}

export const tabSwitch = { focusedTab, onTabs, focusOn, tabKey, hiddenEvent, backgroundStep }
