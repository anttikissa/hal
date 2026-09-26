// The terminal client: one session's transcript above an editable
// prompt. Keys become commands to the host (through the connection), and every
// event from the host is folded into the transcript and shown. Nothing
// here waits on the host. The prompt is the session's draft, kept and
// shared through common/drafts.ts; a sent prompt shows at once, pending
// until the host has it.

import { amend, type Editing } from '../common/amend.ts'
import { connection, type LinkState } from '../common/connection.ts'
import { forms, type FormState } from '../common/forms.ts'
import { drafts } from '../common/drafts.ts'
import { modals, type ModalAction, type ModalState } from '../common/modals.ts'
import type { Event } from '../common/protocol.ts'
import { states } from '../common/states.ts'
import { transcript, type Resumed, type Transcript } from '../common/transcript.ts'
import type { KeyEvent } from './keys.ts'
import { prompt, type PromptState } from './prompt.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'
import type { View } from './frame.ts'

// `resumed`: where the history of the last snapshot ends, marked on screen.
// `form`: the session's open question as filled in here; while there is
// one, keys go to it instead of the prompt.
// `editing`: the last prompt is in the editor (src/common/amend.ts).
// `modal`: client-only UI over everything, taking the keys first;
// `onModal` makes the command its Enter sends.
type AppState = {
	transcript?: Transcript
	resumed?: Resumed
	prompt: PromptState
	notice?: string
	form?: FormState
	editing?: Editing
	modal?: ModalState
	onModal?: (action: Extract<ModalAction, { type: 'submit' }>) => unknown
}

function createState(): AppState {
	return { prompt: prompt.empty() }
}

function view(): View {
	let st = app.state
	let v: View = { prompt: st.prompt }
	if (st.transcript) v.transcript = st.transcript
	if (st.resumed) v.resumed = st.resumed
	let pending = st.transcript ? drafts.pending(st.transcript.meta.id) : []
	if (pending.length) v.pending = pending
	if (st.form) v.form = st.form
	if (st.modal) v.modal = st.modal
	// A passing notice, else what the session is doing.
	let notice = st.notice ?? (st.editing ? amend.hint() : st.transcript && states.describe(st.transcript.state))
	if (notice) v.notice = notice
	return v
}

function show(): void {
	render.show(app.view())
}

function onEvent(event: Event): void {
	let st = app.state
	// Text typed before the first session arrived joins its draft.
	let early = !st.transcript && event.type === 'snapshot' ? st.prompt.text : ''
	if (drafts.onEvent(event) && st.transcript && 'sessionId' in event && event.sessionId === st.transcript.meta.id) app.setPrompt(drafts.text(event.sessionId))
	if (event.type === 'rejected') st.notice = `${event.command} refused: ${event.reason}`
	else if (event.type === 'warning') st.notice = event.text
	else {
		let t = transcript.fold(st.transcript, event)
		if (event.type === 'snapshot' && t && t !== st.transcript) st.resumed = transcript.resumed(event.snapshot, t)
		// An edited prompt may have replaced what the mark was after.
		if (st.resumed && t && st.resumed.at > t.items.length) st.resumed = { ...st.resumed, at: t.items.length }
		st.transcript = t
		if (event.type === 'snapshot' && t) {
			let id = t.meta.id
			if (early) drafts.edit(id, drafts.text(id) ? `${drafts.text(id)}\n${early}` : early)
			app.setPrompt(drafts.text(id))
		}
		st.form = forms.follow(st.form, transcript.question(t))
	}
	app.show()
}

function onState(state: LinkState): void {
	app.state.notice = state.type === 'connected' ? undefined : 'host lost; reconnecting…'
	app.show()
}

// Enter: a prompt (steering a busy turn; `queue`: after it), an edit
// of the last prompt, or a continue on an empty prompt. Refuses (keeping the typed text) what the
// host would refuse anyway.
function submit(text: string, queue = false): boolean {
	let st = app.state
	if (!st.transcript) {
		if (!text.trim()) return true
		st.notice = 'no session yet'
		return false
	}
	// While editing the last prompt, Enter sends the edit.
	let { command, refused } = st.editing
		? { command: amend.enter(st.editing, st.transcript, text, queue), refused: undefined }
		: states.enter(st.transcript.meta.id, st.transcript.state, text, queue)
	if (refused) {
		st.notice = refused
		return false
	}
	st.editing = undefined
	if (command) {
		st.notice = undefined
		let c = command as { type: string; text?: string; queue?: boolean; amend?: boolean }
		if (c.type === 'submit') drafts.submit(st.transcript.meta.id, c.text!, c.queue, c.amend)
		else app.send(command)
	}
	return true
}

// Puts `text` in the prompt, unless it is there already (the cursor
// stays where the user left it).
function setPrompt(text: string): void {
	let st = app.state
	if (st.prompt.text !== text) st.prompt = { text, cursor: text.length }
}

// Up, Down and Escape for editing the last prompt; true if handled. The
// editor text is the draft, as ever.
function editKey(k: KeyEvent): boolean {
	let st = app.state
	let plain = !k.shift && !k.ctrl && !k.alt && !k.cmd
	if (!plain || !st.transcript) return false
	let id = st.transcript.meta.id
	if (k.key === 'up' && !st.editing) {
		let begun = amend.begin(st.transcript, st.prompt.text)
		if (!begun) return false
		st.editing = begun.editing
		st.prompt = { text: begun.editing.original, cursor: begun.editing.original.length }
		drafts.edit(id, st.prompt.text)
		app.send(begun.command)
		return true
	}
	let editing = st.editing
	if (!editing || !(k.key === 'escape' || (k.key === 'down' && st.prompt.text === editing.original))) return false
	st.editing = undefined
	if (st.prompt.text === editing.original) {
		st.prompt = prompt.empty()
		drafts.edit(id, '')
	}
	let command = amend.resume(editing, st.transcript)
	if (command) app.send(command)
	return true
}

function onKeys(events: KeyEvent[]): void {
	let st = app.state
	for (let k of events) {
		if (st.modal) {
			let { state, action } = modals.step(st.modal, k)
			st.modal = state
			if (!action) continue
			let submit = st.onModal
			app.close()
			let command = action.type === 'submit' ? submit?.(action) : undefined
			if (command) app.send(command)
			continue
		}
		if (st.form && st.transcript) {
			let { state, action } = forms.step(st.form, k)
			st.form = state
			if (action) app.send(forms.command(st.transcript.meta.id, state, action))
			continue
		}
		if (app.editKey(k)) continue
		let { state, action } = prompt.apply(st.prompt, k)
		if (action?.type === 'submit' && !app.submit(action.text, action.queue)) continue
		let edited = state.text !== st.prompt.text && action?.type !== 'submit'
		st.prompt = state
		if (edited && st.transcript) drafts.edit(st.transcript.meta.id, state.text)
		let pause = action?.type === 'cancel' && st.transcript && states.escape(st.transcript.meta.id, st.transcript.state)
		if (pause) app.send(pause)
		if (action?.type === 'quit') return terminal.quit()
	}
	app.show()
}

// Opens `modal` over everything. Enter closes it and sends what
// `submit` makes of it (nothing if undefined); Escape just closes it.
function open(modal: ModalState, submit: NonNullable<AppState['onModal']>): void {
	app.state.modal = modal
	app.state.onModal = submit
	app.show()
}

function close(): void {
	delete app.state.modal
	delete app.state.onModal
	app.show()
}

// Takes keys from the terminal and paints the first frame. Idempotent.
function init(): void {
	terminal.onKeys = (events) => app.onKeys(events)
	app.show()
}

function reset(): void {
	app.state = createState()
	drafts.reset()
}

export const app = {
	state: createState(),
	send: (command: unknown): void => connection.send(command),
	view,
	show,
	onEvent,
	onState,
	submit,
	setPrompt,
	editKey,
	onKeys,
	open,
	close,
	init,
	reset,
}
