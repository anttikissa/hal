// Tab switching in the terminal client: the host's tabs as they
// arrive, showing one (following its session, no longer the old one's;
// each keeps its client state meanwhile) and the tab keys. The state
// lives in app.state (tabs, focus, asked, hidden).

import { drafts } from '../common/drafts.ts'
import { prompt } from '../common/prompt.ts'
import type { Tab } from '../common/protocol.ts'
import { recall } from '../common/recall.ts'
import { app, type AppState } from './app.ts'
import type { KeyEvent } from './keys.ts'
import { tabs, type Focus } from './tabs.ts'

// What each tab keeps while another is shown.
export type TabView = Pick<AppState, 'transcript' | 'prompt' | 'notice' | 'form' | 'editing'>
const tabFields = ['transcript', 'prompt', 'notice', 'form', 'editing'] as const

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
	for (let id of st.hidden.keys()) if (!ids.includes(id)) st.hidden.delete(id)
	app.focusOn(tabs.focus(old, ids, st.focus, asked))
	app.show()
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
			let kept = {} as TabView
			for (let f of tabFields) if (st[f] !== undefined) Object.assign(kept, { [f]: st[f] })
			st.hidden.set(from, kept)
			app.send({ type: 'close', sessionId: from })
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
			app.send({ type: 'open', sessionId: focus.tab })
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

export const tabSwitch = { focusedTab, onTabs, focusOn, tabKey }
