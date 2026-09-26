// The terminal client: one session's transcript above an editable
// prompt. Keys become commands to the host (through link), and every
// event from the host is folded into the transcript and shown. Nothing
// here waits on the host.

import type { Event } from '../common/protocol.ts'
import { states } from '../common/states.ts'
import { transcript, type Transcript } from '../common/transcript.ts'
import type { KeyEvent } from './keys.ts'
import { link, type Role } from './link.ts'
import { prompt, type PromptState } from './prompt.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'
import type { View } from './frame.ts'

type AppState = { transcript?: Transcript; prompt: PromptState; notice?: string }

function createState(): AppState {
	return { prompt: prompt.empty() }
}

function view(): View {
	let st = app.state
	let v: View = { prompt: st.prompt }
	if (st.transcript) v.transcript = st.transcript
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
	if (event.type === 'rejected') st.notice = `${event.command} refused: ${event.reason}`
	else if (event.type === 'warning') st.notice = event.text
	else st.transcript = transcript.fold(st.transcript, event)
	app.show()
}

function onRole(role: Role | null): void {
	app.state.notice = role ? undefined : 'host lost; reconnecting…'
	app.show()
}

// Enter: a prompt, or a continue on an empty prompt. Refuses (keeping
// the typed text) what the host would refuse anyway.
function submit(text: string): boolean {
	let st = app.state
	if (!st.transcript) {
		if (!text.trim()) return true
		st.notice = 'no session yet'
		return false
	}
	let { command, refused } = states.enter(st.transcript.meta.id, st.transcript.state, text)
	if (refused) {
		st.notice = refused
		return false
	}
	if (command) {
		st.notice = undefined
		app.send(command)
	}
	return true
}

function onKeys(events: KeyEvent[]): void {
	let st = app.state
	for (let k of events) {
		let { state, action } = prompt.apply(st.prompt, k)
		if (action?.type === 'submit' && !app.submit(action.text)) continue
		st.prompt = state
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
}

export const app = {
	state: createState(),
	send: (command: unknown): void => link.send(command),
	view,
	show,
	onEvent,
	onRole,
	submit,
	onKeys,
	init,
	reset,
}
