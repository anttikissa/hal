/// <reference lib="dom" />
// The browser client's controller, without Solid or the DOM tree: the
// view (view.ts) and the message box's text as plain state, changed
// synchronously by host events and user input, then handed to the
// components through `changed` (main.tsx points it at a signal). Keys
// are keys.ts's job.
//
// The box is the session's draft (common/drafts.ts, kept in
// localStorage too); a sent prompt shows at once, pending until the
// host has it.
//
// Tabs are the host's (task 0a); which one shows is this page's, named
// by the address (tabs.ts, router.ts).

import { backfill, type Backfill } from '../common/backfill.ts'
import { connection, type LinkState } from '../common/connection.ts'
import { drafts, type Local, type Sending } from '../common/drafts.ts'
import { forms, type FormAction, type Key } from '../common/forms.ts'
import { placeholders } from '../common/placeholders.ts'
import type { Event, Tab } from '../common/protocol.ts'
import { recall } from '../common/recall.ts'
import { uploads, type Settled } from '../common/uploads.ts'
import { link } from './link.ts'
import { tabs } from './tabs.ts'
import { view, type ViewState } from './view.ts'

// `kill`: the last text Ctrl-K/U or Alt-D killed, for Ctrl-Y.
// `tabs`: the host's, in order; `shown`: the tab this page shows;
// `asked`: ids of tab-new commands sent here, whose tab then shows.
// `older`: each session's earlier history being fetched as the reader
// scrolls up (common/backfill.ts); `pages` counts the pages shown, so
// the page can keep what the reader was reading in place.
export type AppState = { view: ViewState; text: string; tabs: Tab[]; shown?: string; asked: Set<string>; kill?: string; older: Map<string, Backfill>; pages: number }


function createState(): AppState {
	return { view: {}, text: '', tabs: [], asked: new Set(), older: new Map(), pages: 0 }
}

function sessionId(): string | undefined {
	return app.state.view.transcript?.meta.id
}

// Prompts sent and not acknowledged, shown after the transcript.
function pending(): Sending[] {
	let id = app.sessionId()
	return id ? drafts.pending(id) : []
}

function notice(): string | undefined {
	return view.notice(app.state.view)
}

// A dim example request for the box, another each turn; the textarea
// shows it only while empty. The Hal repo has its own (Tab `hal`).
function placeholder(): string | undefined {
	let t = app.state.view.transcript
	let hal = !!app.state.tabs.find((tab) => tab.id === app.state.shown)?.hal
	return t && placeholders.pick(hal, t.items.filter((i) => i.type === 'prompt').length)
}

function setView(v: ViewState): void {
	app.state.view = v
	app.changed()
}

function setNotice(notice: string | undefined): void {
	app.setView({ ...app.state.view, notice })
}

// Sends a command that makes no sense later: refused with a notice
// while disconnected. True if sent.
function sendNow(command: unknown): boolean {
	if (!connection.connected()) {
		app.setNotice('not connected; try again in a moment')
		return false
	}
	connection.send(command)
	return true
}

function onEvent(event: Event): void {
	let st = app.state
	if (tabs.onEvent(event)) return
	let changed = drafts.onEvent(event)
	let landed = uploads.settle(event)
	if (landed) app.settled(landed)
	st.view = view.onEvent(st.view, event)
	if (event.type === 'snapshot') backfill.onSnapshot(st.older, event)
	if (event.type === 'history' && backfill.onPage(st.older, event) && st.view.transcript?.meta.id === event.sessionId) {
		let { transcript: t, resumed } = st.view
		let shown = backfill.apply(st.older, t)
		st.view = { ...st.view, transcript: shown, ...(resumed ? { resumed: { ...resumed, at: resumed.at + shown.items.length - t.items.length } } : {}) }
		st.pages++
	}
	let done = event.type === 'completions' && view.completed(st.view, event, st.text)
	if (done) {
		st.view = { ...st.view, notice: done.notice }
		return app.input(done.text)
	}
	let id = app.sessionId()
	// A recalled entry stays in the box; the draft changes underneath.
	if (id && (changed || event.type === 'snapshot')) st.text = recall.shown(id) ?? drafts.text(id)
	app.changed()
}

// An upload landed or failed (common/uploads.ts): its placeholder
// becomes the marker or an error text, in the box if it shows the
// session and in the draft; a send waiting for it goes now.
function settled(done: Settled): void {
	let shown = app.sessionId() === done.sessionId
	if (shown) app.rewrite((p) => uploads.swap(p, done.placeholder, done.text))
	let draft = drafts.text(done.sessionId)
	if (draft.includes(done.placeholder)) drafts.edit(done.sessionId, draft.replace(done.placeholder, () => done.text))
	if (shown && done.resume) app.send(done.resume.queue)
}

// The reader is near the top: ask for the page before it, if any.
function older(): void {
	let id = app.sessionId()
	let command = id && backfill.next(app.state.older, id)
	if (command) connection.send(command)
}

function onState(state: LinkState): void {
	if (state.type === 'connected') tabs.connected()
	app.setNotice(state.type === 'connected' ? undefined : state.type === 'joining' ? 'connecting…' : 'disconnected; reconnecting…')
}

// The message box now says `text`.
function input(text: string): void {
	app.state.text = text
	let id = app.sessionId()
	if (id && recall.typed(id, text)) drafts.edit(id, text)
	app.changed()
}

// Open question: a text field typed into, a field focused, an option
// clicked (on a one-field form that answers), the form submitted.
function formInput(index: number, value: string): void {
	let form = app.state.view.form
	if (form) app.setView({ ...app.state.view, form: forms.set(form, index, value) })
}

function formFocus(index: number): void {
	let form = app.state.view.form
	if (form && form.focus !== index) app.setView({ ...app.state.view, form: forms.focusOn(form, index) })
}

function pick(index: number, option: string): void {
	let form = app.state.view.form
	if (!form) return
	form = forms.set(form, index, option)
	app.setView({ ...app.state.view, form })
	if (form.form.fields.length === 1) app.sendForm({ type: 'submit', answers: forms.answers(form) })
}

function submitForm(): void {
	let form = app.state.view.form
	if (form) app.sendForm({ type: 'submit', answers: forms.answers(form) })
}

function sendForm(action: FormAction): void {
	let { form, transcript } = app.state.view
	if (form && transcript) app.sendNow(forms.command(transcript.meta.id, form, action))
}

// The model picker: a key (Enter picks, Escape closes), a click on an
// item, the search box typed into.
function modalKey(k: Key): void {
	let { state, command } = view.modalKey(app.state.view, k)
	app.setView(state)
	if (command) app.sendNow(command)
}

function modalPick(index: number): void {
	let modal = app.state.view.modal
	if (!modal) return
	app.state.view = { ...app.state.view, modal: { ...modal, selected: index } }
	app.modalKey({ key: 'enter' })
}

function search(text: string): void {
	app.setView(view.search(app.state.view, text))
}

// Sends what the box holds (Enter, or the Send button); `queue`
// (Alt+Enter) waits for the running turn.
function send(queue = false): void {
	let st = app.state
	let id = app.sessionId()
	if (id && uploads.pending(id)) {
		uploads.wait(id, queue)
		return app.setNotice('sending once the upload is done')
	}
	let { command, notice, keep } = view.submit(st.view, st.text, queue)
	let c = command as { type: string; sessionId: string; text?: string; queue?: boolean; amend?: boolean; edits?: string } | undefined
	// A prompt shows at once and waits, pending, for the host.
	if (c?.type === 'submit') drafts.submit(c.sessionId, c.text!, c.queue, c.amend, c.edits)
	else if (c) connection.send(c)
	if (!keep) {
		st.view = { ...st.view, editing: undefined }
		// A recalled entry was sent: the user's own text comes back.
		let back = c?.type === 'submit' && recall.stop(c.sessionId)
		app.input(back ? drafts.text(c!.sessionId) : '')
	}
	app.setNotice(notice)
}

// The browser's local copy of drafts, for typing while disconnected
// and prompts not yet acknowledged when the tab closes.
const store = {
	load: (id: string): Local | undefined => {
		try {
			return JSON.parse(localStorage.getItem(`hal-draft:${id}`) ?? 'null') ?? undefined
		} catch {
			return undefined
		}
	},
	save: (id: string, local: Local): void => {
		try {
			if (!local.text && !local.sending.length) localStorage.removeItem(`hal-draft:${id}`)
			else localStorage.setItem(`hal-draft:${id}`, JSON.stringify(local))
		} catch {
			// Storage full or disabled: the host still has the draft.
		}
	},
}

// Connects to the host (reconnecting with backoff; each connection
// brings the tabs and a fresh snapshot of the shown one) and follows
// Back and Forward.
function start(): void {
	drafts.store = app.store
	let scheme = location.protocol === 'https:' ? 'wss' : 'ws'
	link.start({
		dial: () => new WebSocket(`${scheme}://${location.host}/ws?v=${document.documentElement.dataset.version}`),
		reload: () => location.reload(),
		authorized: () => app.authorized(),
		onEvent: (e) => app.onEvent(e),
		onState: (s) => app.onState(s),
	})
	addEventListener('popstate', () => tabs.onPopState())
}

// Whether the cookie is good; logging in sets it. login answers the
// notice to show, or undefined once logged in.
async function authorized(): Promise<boolean> {
	return (await fetch('/login')).status !== 401
}

async function login(code: string): Promise<string | undefined> {
	let body = new FormData()
	body.set('code', code)
	let res = await fetch('/login', { method: 'POST', body })
	if (res.ok) return undefined
	if (res.status === 401) return 'wrong or expired code'
	return res.status === 429 ? 'too many wrong codes; try again in a minute' : `login failed (${res.status})`
}

function reset(): void {
	app.state = createState()
	recall.reset()
	uploads.reset()
}

export const app = {
	state: createState(),
	// Called after every change; main.tsx redraws from app.state.
	changed: (): void => {},
	sessionId,
	pending,
	notice,
	placeholder,
	setView,
	setNotice,
	sendNow,
	onEvent,
	settled,
	// Changes the box's text (and caret) by `change`; the Composer edits
	// the textarea in place instead.
	rewrite: (change: (p: { text: string; cursor: number; anchor?: number }) => { text: string }): void =>
		app.input(change({ text: app.state.text, cursor: app.state.text.length }).text),
	older,
	onState,
	input,
	formInput,
	formFocus,
	pick,
	submitForm,
	sendForm,
	modalKey,
	modalPick,
	search,
	send,
	store,
	start,
	authorized,
	login,
	reset,
}
