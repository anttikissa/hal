// What the terminal client shows: the frame's View derived from the
// app state (client/app.ts), the status row's facts and the words for
// a session's state. Reads only; app.show() paints it.

import { bashResult } from '../common/bash-result.ts'
import { colors } from '../common/colors.ts'
import { queueEdit } from '../common/queue-edit.ts'
import { amend } from '../common/amend.ts'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import { notices } from '../common/notices.ts'
import { placeholders, type PromptExample } from '../common/placeholders.ts'
import { states } from '../common/states.ts'
import type { Transcript } from '../common/transcript.ts'
import { app } from './app.ts'
import type { View } from './frame.ts'
import { halCursor } from './hal-cursor.ts'
import { pulse } from './pulse.ts'
import type { StatusInfo } from './status-row.ts'
import { tabBar } from './tab-bar.ts'
import { versions } from './versions.ts'
import { find } from './find.ts'
import { folds } from './folds.ts'

function view(): View {
	let st = app.state
	let v: View = { prompt: st.prompt }
	if (st.transcript) v.transcript = st.transcript
	if (find.target && find.target.sessionId === st.transcript?.meta.id) v.target = find.target.blockId
	let pending = st.transcript ? drafts.pending(st.transcript.meta.id).map((s) => s.text) : []
	if (pending.length) v.pending = pending
	if (st.form) v.form = st.form
	if (st.modal) v.modal = st.modal
	if (st.choices) v.choices = st.choices
	// An example request over the prompt (placeholders.follow); none for
	// the intro, which can't take requests.
	let t = st.transcript
	let list = t && t.meta.model !== 'hal/intro' ? (app.focusedTab()?.hal ? placeholders.hal : placeholders.general) : undefined
	let example = placeholders.follow(appView.state.example, t?.meta.id ?? '', list, st.prompt.text, pulse.now())
	if (example) v.placeholder = example
	if (st.tabs.length) v.tabs = st.focus.tab === undefined ? { list: st.tabs } : { list: st.tabs, focused: st.focus.tab }
	if (v.tabs && tabBar.blinks(st.tabs)) v.tabs.lit = pulse.slow(pulse.beat())
	let stopped = t && appView.why(t), notice = st.notice ?? (t && queueEdit.notice(t)) ?? versions.notice()
	if (stopped) v.why = stopped
	if (notice) v.notice = notice
	if (st.editing) v.editing = amend.hint(st.editing)
	if (versions.state.newCode) v.newCode = true
	let activity = t && appView.activity(t)
	if (activity) v.activity = activity
	let hal = halCursor.of(st.transcript, pulse.beat())
	if (hal) v.hal = hal
	let states = t && folds.state.folds.get(t.meta.id)
	if (states?.size) v.folds = { states, pastes: folds.state.pastes, sig: `${[...states].join()} ${[...folds.state.pastes.values()].filter((p) => p.text !== undefined || p.error).length}` }
	let tick = t && appView.tick(t, Date.now())
	if (tick) v.tick = tick
	if (t) v.status = appView.status(t)
	if (notices.state.entries.length) v.notices = notices.fold(notices.state.entries)
	return v
}

// The status row's facts (client/status-row.ts): the session's, and
// once connected, this process's role, or the remote host's name.
function status(t: Transcript): StatusInfo {
	let { id, name, cwd, model } = t.meta
	let s: StatusInfo = { id, cwd, model, autoclose: t.meta.autoclose }
	if (name) s.name = name
	if (app.focusedTab()?.hal) s.hal = true
	let color = app.focusedTab()?.color
	if (color !== undefined) s.color = colors.project()[`p${color}`]
	if (process.env.HOME) s.home = process.env.HOME
	if (t.stats) s.stats = t.stats
	let link = connection.state.link
	if (link.type === 'connected') s.role = appView.state.remote ?? (link.role === 'host' ? 'host' : 'peer')
	if (appView.state.plugins) s.plugins = appView.state.plugins
	return s
}

// The activity in the prompt's top rule: a word or two, never a message
// clipped to the row; the whole sentence is the notice (why).
function activity(t: Transcript): string | undefined {
	if (queueEdit.waiting(t)) return 'waiting for queue edit'
	let s = t.state
	if (s.type === 'blocked') return s.reason === 'question' ? 'waiting for answer' : `blocked: ${s.reason.split(':')[0]}`
	if (s.type === 'paused') return 'paused'
	if (s.type === 'error') return 'error'
	if (s.type === 'retrying') return (states.describe(s, Date.now()) ?? '').replace(/ \(.*$/s, '')
	return states.describe(s, Date.now(), t.items)
}

// Why a stopped session waits and what the user can do, in full.
function why(t: Transcript): string | undefined {
	if (queueEdit.waiting(t)) return 'The next queued message is being edited. It is sent when the edit is saved or canceled.'
	let s = t.state
	if (s.type === 'running' || s.type === 'idle' || (s.type === 'blocked' && s.reason === 'question')) return undefined
	// Paused. and the help row's enter: continue say the rest.
	if (s.type === 'paused') return s.reason || undefined
	return states.describe(s, Date.now(), t.items)
}

// The running tool call's elapsed time, from 1 s on (task wm0).
function tick(t: Transcript, now: number): View['tick'] {
	let s = t.state
	if (s.type !== 'running' || s.phase !== 'tools' || !s.call || !s.since) return undefined
	let label = bashResult.duration(now - Date.parse(s.since), true)
	return label ? { call: s.call, label } : undefined
}

// What blinks in `view`, as a key that changes with every blink phase;
// a ticking time counts.
function blinks(view: View): string {
	let lit = view.tabs?.lit
	return view.hal || lit !== undefined || view.tick ? JSON.stringify([view.hal, lit, view.tick]) : ''
}

export const appView = {
	// `remote`: the host's name when following a remote one (task tr),
	// shown where the role would be.
	// `plugins`: the plugin sync indicator of a remote terminal (b81).
	// `example`: the prompt example's clock (placeholders.follow).
	state: { remote: undefined as string | undefined, plugins: undefined as string | undefined, example: {} as PromptExample },
	view,
	status,
	activity,
	why,
	tick,
	blinks,
}
