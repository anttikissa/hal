/// <reference lib="dom" />
// The browser client's controller, without Solid or the DOM tree: the
// view (view.ts) and the message box's text as plain state, changed
// synchronously by host events and user input, then handed to the
// components through `changed` (main.tsx points it at a signal).
//
// Enter submits (steering a running turn; Alt+Enter queues after it,
// Shift+Enter is a newline), Escape pauses a running turn, Up on an
// empty box edits the last prompt (src/common/amend.ts), Tab completes
// a slash command, Ctrl-M opens the model picker. The box is the
// session's draft (common/drafts.ts, kept in localStorage too); a sent
// prompt shows at once, pending until the host has it.

import { connection, type LinkState } from '../common/connection.ts'
import { drafts, type Local } from '../common/drafts.ts'
import { forms, type FormAction, type Key } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import { prompt } from '../common/prompt.ts'
import { editor, type Splice } from './editor.ts'
import { link } from './link.ts'
import { view, type ViewState } from './view.ts'

// `kill`: the last text Ctrl-K/U or Alt-D killed, for Ctrl-Y.
export type AppState = { view: ViewState; text: string; kill?: string }

// Where a key was pressed: the message box (its text, the caret, and
// `write`, which edits the box natively), a text field of the open
// question, a button (`submits`: a form's submit button), or anywhere
// else.
export type Target =
	| { kind: 'message'; text: string; cursor: number; write?: (edit: Splice, cursor: number) => void }
	| { kind: 'field' }
	| { kind: 'button'; submits: boolean }
	| { kind: 'other' }

// `code`: the physical key (KeyD), for Option-letters on macOS.
export type KeyInput = { key: string; code?: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing?: boolean }

function createState(): AppState {
	return { view: {}, text: '' }
}

function sessionId(): string | undefined {
	return app.state.view.transcript?.meta.id
}

// Prompts sent and not acknowledged, shown after the transcript.
function pending(): string[] {
	let id = app.sessionId()
	return id ? drafts.pending(id) : []
}

function notice(): string | undefined {
	return view.notice(app.state.view)
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
	let changed = drafts.onEvent(event)
	st.view = view.onEvent(st.view, event)
	let done = event.type === 'completions' && view.completed(st.view, event, st.text)
	if (done) {
		st.view = { ...st.view, notice: done.notice }
		return app.input(done.text)
	}
	let id = app.sessionId()
	if (id && (changed || event.type === 'snapshot')) st.text = drafts.text(id)
	app.changed()
}

function onState(state: LinkState): void {
	app.setNotice(state.type === 'connected' ? undefined : state.type === 'joining' ? 'connecting…' : 'disconnected; reconnecting…')
}

// The message box now says `text`.
function input(text: string): void {
	app.state.text = text
	let id = app.sessionId()
	if (id) drafts.edit(id, text)
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

const arrows: Record<string, 'up' | 'down' | 'escape'> = { ArrowUp: 'up', ArrowDown: 'down', Escape: 'escape' }

// A key pressed on the page. True if handled here (the caller then
// prevents the browser's default).
function key(e: KeyInput, target: Target): boolean {
	let st = app.state
	if (e.isComposing) return false
	// The message box may hold text no input event told us about.
	if (target.kind === 'message' && target.text !== st.text) app.input(target.text)
	let k = view.key(e)
	// The modal takes the keys first; its search box edits natively.
	if (st.view.modal) {
		if (!k || !['enter', 'escape', 'up', 'down'].includes(k.key)) return false
		app.modalKey(k)
		return true
	}
	let models = k && view.modelsKey(st.view, k)
	if (models) {
		connection.send(models)
		return true
	}
	if (st.view.form) {
		// Text fields edit natively, a submit button submits; the shared
		// form keys decide the rest.
		let native = target.kind === 'field' && !['enter', 'escape', 'tab', 'up', 'down'].includes(k?.key ?? '')
		if (!k || native || (target.kind === 'button' && target.submits && e.key === 'Enter')) return false
		let { state, command } = view.formKey(st.view, k)
		app.setView(state)
		if (command) app.sendNow(command)
		return true
	}
	let plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
	let edit = plain && target.kind === 'message' && arrows[e.key] ? view.editKey(st.view, arrows[e.key]!, st.text) : undefined
	if (edit) {
		st.view = edit.view
		if (edit.command) connection.send(edit.command)
		app.input(edit.text)
		return true
	}
	if (e.key === 'Escape') {
		let command = view.pause(st.view)
		if (command) connection.send(command)
		return false
	}
	if (target.kind !== 'message') return false
	if (k && editor.routed(k)) return app.edit(k, target)
	let complete = e.key === 'Tab' && !e.shiftKey && target.cursor === st.text.length && view.complete(st.view, st.text)
	if (complete) {
		connection.send(complete)
		return true
	}
	if (e.key !== 'Enter' || e.shiftKey) return false
	app.send(e.altKey)
	return true
}

// A key from editor.table on the message box: the shared editor's step
// on its text and caret, written back as a native edit.
function edit(k: Key, target: Extract<Target, { kind: 'message' }>): boolean {
	let st = app.state
	let { state } = prompt.step({ text: st.text, cursor: target.cursor, kill: st.kill }, k)
	st.kill = state.kill
	if (state.text !== st.text) target.write?.(editor.splice(st.text, state.text), state.cursor)
	app.input(state.text)
	return true
}

// Sends what the box holds (Enter, or the Send button); `queue`
// (Alt+Enter) waits for the running turn.
function send(queue = false): void {
	let st = app.state
	let { command, notice, keep } = view.submit(st.view, st.text, queue)
	let c = command as { type: string; sessionId: string; text?: string; queue?: boolean; amend?: boolean } | undefined
	// A prompt shows at once and waits, pending, for the host.
	if (c?.type === 'submit') drafts.submit(c.sessionId, c.text!, c.queue, c.amend)
	else if (c) connection.send(c)
	if (!keep) {
		st.view = { ...st.view, editing: undefined }
		app.input('')
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
// brings a fresh snapshot) and opens the newest session, or a new one
// in the host's working directory.
function start(): void {
	drafts.store = app.store
	let scheme = location.protocol === 'https:' ? 'wss' : 'ws'
	link.start({
		dial: () => new WebSocket(`${scheme}://${location.host}/ws`),
		onEvent: (e) => app.onEvent(e),
		onState: (s) => app.onState(s),
	})
	connection.send({ type: 'open-newest' })
}

// Whether the cookie is good; logging in sets it. login answers the
// notice to show, or undefined once logged in.
async function authorized(): Promise<boolean> {
	return (await fetch('/login')).status !== 401
}

async function login(password: string): Promise<string | undefined> {
	let body = new FormData()
	body.set('password', password)
	let res = await fetch('/login', { method: 'POST', body })
	if (res.ok) return undefined
	return res.status === 401 ? 'wrong password' : `login failed (${res.status})`
}

function reset(): void {
	app.state = createState()
}

export const app = {
	state: createState(),
	// Called after every change; main.tsx redraws from app.state.
	changed: (): void => {},
	sessionId,
	pending,
	notice,
	setView,
	setNotice,
	sendNow,
	onEvent,
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
	key,
	edit,
	send,
	store,
	start,
	authorized,
	login,
	reset,
}
