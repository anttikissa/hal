// The terminal client: one session's transcript above an editable
// prompt. Keys become commands to the host (through link), and every
// event from the host is folded into the transcript and shown. Nothing
// here waits on the host.

import type { Event } from '../common/protocol.ts'
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
	if (st.notice) v.notice = st.notice
	return v
}

function show(): void {
	render.show(app.view())
}

function onEvent(event: Event): void {
	let st = app.state
	if (event.type === 'rejected') st.notice = `${event.command} refused: ${event.reason}`
	else st.transcript = transcript.fold(st.transcript, event)
	app.show()
}

function onRole(role: Role | null): void {
	app.state.notice = role ? undefined : 'host lost; reconnecting…'
	app.show()
}

// Refuses (keeping the typed text) what the host would refuse anyway.
function submit(text: string): boolean {
	let st = app.state
	if (!text.trim()) return true
	if (!st.transcript) st.notice = 'no session yet'
	else if (st.transcript.live) st.notice = 'a turn is running; Escape cancels it'
	else {
		st.notice = undefined
		app.send({ type: 'submit', sessionId: st.transcript.meta.id, text })
		return true
	}
	return false
}

function onKeys(events: KeyEvent[]): void {
	let st = app.state
	for (let k of events) {
		let { state, action } = prompt.apply(st.prompt, k)
		if (action?.type === 'submit' && !app.submit(action.text)) continue
		st.prompt = state
		if (action?.type === 'cancel' && st.transcript?.live) app.send({ type: 'cancel', sessionId: st.transcript.meta.id })
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
