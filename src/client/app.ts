// The terminal client: one session's transcript above an editable
// prompt. Keys become commands to the host (through the connection), and every
// event from the host is folded into the transcript and shown. Nothing
// here waits on the host. The prompt is the session's draft, kept and
// shared through common/drafts.ts; a sent prompt shows at once, pending
// until the host has it.

import { connection, type LinkState } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { states } from '../common/states.ts'
import { transcript, type Resumed, type Transcript } from '../common/transcript.ts'
import type { KeyEvent } from './keys.ts'
import { prompt, type PromptState } from './prompt.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'
import type { View } from './frame.ts'

// `resumed`: where the history of the last snapshot ends, marked on screen.
type AppState = { transcript?: Transcript; resumed?: Resumed; prompt: PromptState; notice?: string }

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
	// A passing notice, else what the session is doing.
	let notice = st.notice ?? (st.transcript && states.describe(st.transcript.state))
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
		st.transcript = t
		if (event.type === 'snapshot' && t) {
			let id = t.meta.id
			if (early) drafts.edit(id, drafts.text(id) ? `${drafts.text(id)}\n${early}` : early)
			app.setPrompt(drafts.text(id))
		}
	}
	app.show()
}

function onState(state: LinkState): void {
	app.state.notice = state.type === 'connected' ? undefined : 'host lost; reconnecting…'
	app.show()
}

// Enter: a prompt (steering a busy turn; `queue`: after it), or a
// continue on an empty prompt. Refuses (keeping the typed text) what the
// host would refuse anyway.
function submit(text: string, queue = false): boolean {
	let st = app.state
	if (!st.transcript) {
		if (!text.trim()) return true
		st.notice = 'no session yet'
		return false
	}
	let { command, refused } = states.enter(st.transcript.meta.id, st.transcript.state, text, queue)
	if (refused) {
		st.notice = refused
		return false
	}
	if (command) {
		st.notice = undefined
		let c = command as { type: string; text?: string; queue?: boolean }
		if (c.type === 'submit') drafts.submit(st.transcript.meta.id, c.text!, c.queue)
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

function onKeys(events: KeyEvent[]): void {
	let st = app.state
	for (let k of events) {
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
	onKeys,
	init,
	reset,
}
