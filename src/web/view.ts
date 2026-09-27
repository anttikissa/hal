// The browser client's state, without the DOM: the transcript folded
// from host events (the same transcript.fold the terminal uses), a
// passing notice, and what each item looks like as text. app.ts feeds
// it the events from link.ts; the components draw it.

import { amend, type Editing } from '../common/amend.ts'
import { completion } from '../common/completion.ts'
import { forms, type FormState, type Key } from '../common/forms.ts'
import { inbox } from '../common/inbox.ts'
import { modals, type ModalState } from '../common/modals.ts'
import { picker } from '../common/picker.ts'
import type { Event } from '../common/protocol.ts'
import { states } from '../common/states.ts'
import { transcript, type Item, type Resumed, type Transcript } from '../common/transcript.ts'

// `resumed`: where the history of the last snapshot ends, marked on the page.
// `form`: the open question as filled in on this page.
// `editing`: the last prompt is in the input (src/common/amend.ts).
// `modal`: the model picker over the page, taking the keys first;
// `models` the host's full list it filters.
export type ViewState = { transcript?: Transcript; resumed?: Resumed; notice?: string; form?: FormState; editing?: Editing; modal?: ModalState; models?: string[] }

// One transcript item as shown: CSS classes and its text. The classes
// are theme style names (src/common/colors.ts in kebab case), whose CSS
// the host puts in the page. Null shows
// nothing (a completed turn end).
export type Shown = { kind: string; text: string } | null

function onEvent(st: ViewState, event: Event): ViewState {
	if (event.type === 'rejected') return { ...st, notice: `${event.command} refused: ${event.reason}` }
	if (event.type === 'warning') return { ...st, notice: event.text }
	if (event.type === 'models') return event.sessionId === st.transcript?.meta.id ? { ...st, modal: picker.open(event.current, event.items), models: event.items } : st
	let t = transcript.fold(st.transcript, event)
	if (t === st.transcript) return st
	let next: ViewState = { ...st, transcript: t }
	if (event.type === 'snapshot' && t) next.resumed = transcript.resumed(event.snapshot, t)
	// An edited prompt may have replaced what the mark was after.
	else if (st.resumed && t && st.resumed.at > t.items.length) next.resumed = { ...st.resumed, at: t.items.length }
	let form = forms.follow(st.form, transcript.question(t))
	if (form) next.form = form
	else delete next.form
	return next
}

// A browser key as a form key, or undefined for keys forms ignore.
// With Alt, macOS types a symbol (Option-D is ∂): the physical key's
// letter names it then.
function key(e: { key: string; code?: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): Key | undefined {
	let names: Record<string, string> = { Enter: 'enter', Escape: 'escape', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Backspace: 'backspace', Delete: 'delete', Home: 'home', End: 'end' }
	let mods = { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, cmd: e.metaKey }
	if (names[e.key]) return { key: names[e.key]!, ...mods }
	let letter = e.altKey && !/^[a-z]$/i.test(e.key) && /^Key([A-Z])$/.exec(e.code ?? '')?.[1]
	if (letter) return { key: letter.toLowerCase(), ...mods }
	return [...e.key].length === 1 ? { key: e.key, text: e.key, ...mods } : undefined
}

// A key on the open form: the new state and the command to send, if any
// (the answer, or a pause for Escape).
function formKey(st: ViewState, k: Key): { state: ViewState; command?: unknown } {
	if (!st.form || !st.transcript) return { state: st }
	let { state, action } = forms.step(st.form, k)
	let next = { ...st, form: state }
	return action ? { state: next, command: forms.command(st.transcript.meta.id, state, action) } : { state: next }
}

// Ctrl-M: the command asking the host for the model list.
function modelsKey(st: ViewState, k: Key): unknown {
	let ctrlM = k.key === 'm' && k.ctrl && !k.alt && !k.cmd
	return ctrlM && st.transcript ? { type: 'models', sessionId: st.transcript.meta.id } : undefined
}

function closed(st: ViewState): ViewState {
	let { modal: _m, models: _l, ...rest } = st
	return rest
}

// A key on the open modal: the view after and the command Enter sends.
function modalKey(st: ViewState, k: Key): { state: ViewState; command?: unknown } {
	if (!st.modal || !st.transcript) return { state: st }
	let { state, action } = modals.step(st.modal, k)
	if (!action) return { state: { ...st, modal: picker.refilter(state, st.models ?? []) } }
	let command = action.type === 'submit' ? picker.command(st.transcript.meta.id, state, action) : undefined
	return command ? { state: closed(st), command } : { state: closed(st) }
}

// The search box now says `text` (typed natively in its input).
function search(st: ViewState, text: string): ViewState {
	if (!st.modal?.form) return st
	let modal = { ...st.modal, form: forms.set(st.modal.form, 0, text), selected: 0, scroll: 0 }
	return { ...st, modal: picker.refilter(modal, st.models ?? []) }
}

// What Enter with `text` does: send a prompt (steering a busy turn;
// `queue`, Alt-Enter: after it), a continue (empty, on a paused or
// failed turn), or show why not (the typed text stays).
// While editing the last prompt, Enter sends the edit.
function submit(st: ViewState, text: string, queue = false): { command?: unknown; notice?: string; keep: boolean } {
	if (st.editing) {
		let command = amend.enter(st.editing, st.transcript, text, queue)
		return command ? { command, keep: false } : { keep: false }
	}
	if (!st.transcript) return text.trim() ? { notice: 'no session yet', keep: true } : { keep: false }
	let { command, refused } = states.enter(st.transcript.meta.id, st.transcript.state, text, queue)
	if (refused) return { notice: refused, keep: true }
	return command ? { command, keep: false } : { keep: false }
}

// Up, Down or Escape with `text` in the input, for editing the last
// prompt: the view after, the command to send and the input's new text;
// undefined if the key means nothing here.
function editKey(st: ViewState, key: 'up' | 'down' | 'escape', text: string): { view: ViewState; command?: unknown; text: string } | undefined {
	if (key === 'up') {
		let begun = !st.editing && amend.begin(st.transcript, text)
		return begun ? { view: { ...st, editing: begun.editing }, command: begun.command, text: begun.editing.original } : undefined
	}
	let editing = st.editing
	if (!editing || (key === 'down' && text !== editing.original)) return undefined
	let command = amend.resume(editing, st.transcript)
	let out: { view: ViewState; command?: unknown; text: string } = { view: { ...st, editing: undefined }, text: text === editing.original ? '' : text }
	if (command) out.command = command
	return out
}

// The row the resumed mark goes before (rows.length: after the last),
// given the item index where replayed history ends.
function markRow(rows: Row[], at: number): number {
	let i = rows.findIndex((r) => r.at >= at)
	return i < 0 ? rows.length : i
}

// The passing notice, else the hint while editing the last prompt.
function notice(st: ViewState): string | undefined {
	return st.notice ?? (st.editing && amend.hint())
}

// Tab in the message box with `text` (the caret at its end): the
// command asking the host to complete it, if it is a slash command.
function complete(st: ViewState, text: string): unknown {
	return st.transcript && completion.request(st.transcript.meta.id, text)
}

// The host's completions, if the box still holds `input`, what was
// sent: its new text and what to tell (the choices, or none found).
function completed(st: ViewState, event: Event & { type: 'completions' }, input: string): { text: string; notice?: string } | undefined {
	if (st.transcript?.meta.id !== event.sessionId || input !== event.text) return undefined
	let { text, choices } = completion.apply(event.text, event.items)
	let notice = choices ? choices.join('  ') : event.items.length ? undefined : 'no completions'
	return notice === undefined ? { text } : { text, notice }
}

// The pause command for Escape, if anything is running.
function pause(st: ViewState): unknown {
	return st.transcript && states.escape(st.transcript.meta.id, st.transcript.state)
}

// The messages waiting for the turn, each with why it waits.
function waiting(st: ViewState): { text: string; label: string }[] {
	let t = st.transcript
	return t ? t.inbox.map((m) => ({ text: m.text, label: inbox.label(t.state, m) })) : []
}

// Whether the model is streaming its thinking (Hal's cursor dims).
function thinking(st: ViewState): boolean {
	let t = st.transcript
	return t?.state.type === 'running' && t.state.phase === 'streaming' && t.items.at(-1)?.type === 'thinking'
}

// The composer's status line, like the terminal's: what the session is
// doing in a word or two, and its tone (busy pulses; warn and error
// need the user).
export type Line = { text: string; tone: 'idle' | 'busy' | 'warn' | 'error' }

function line(st: ViewState, connected: boolean): Line {
	let t = st.transcript
	if (!connected) return { text: 'reconnecting', tone: 'error' }
	if (!t) return { text: 'connecting', tone: 'busy' }
	let s = t.state
	if (s.type === 'idle') return { text: 'idle', tone: 'idle' }
	if (s.type === 'running') {
		if (s.phase === 'tools') {
			let done = new Set(t.items.flatMap((i) => (i.type === 'tool-result' ? [i.id] : [])))
			let names = t.items.flatMap((i) => (i.type === 'tool' && !done.has(i.id) ? [i.name] : []))
			return { text: names.length ? `running ${names.join(', ')}` : 'running tools', tone: 'busy' }
		}
		let writing = s.phase === 'streaming' && !view.thinking(st)
		return { text: writing ? 'writing' : 'thinking', tone: 'busy' }
	}
	let text = states.describe(s)!
	return { text, tone: s.type === 'error' ? 'error' : s.type === 'retrying' ? 'busy' : 'warn' }
}

// The key hints under the message box, for what Enter does now.
function hints(st: ViewState): [key: string, does: string][] {
	if (st.transcript && states.busy(st.transcript.state))
		return [['enter', 'steer'], ['alt+enter', 'queue'], ['shift+enter', 'newline'], ['esc', 'pause']]
	return [['enter', 'send'], ['shift+enter', 'newline'], ['↑', 'edit last'], ['tab', 'complete'], ['ctrl+m', 'model']]
}

// A transcript row: an item, and for a tool call its result once it
// came. Rows only grow at the end as items do (a result joins its
// call's row), so rows keyed by position keep their DOM.
export type Row = { item: Item; at: number; result?: Item & { type: 'tool-result' } }

function rows(items: Item[]): Row[] {
	let out: Row[] = []
	let calls = new Map<string, Row>()
	for (let [at, item] of items.entries()) {
		if (item.type === 'turn-end' && item.status === 'completed') continue
		let call = item.type === 'tool-result' ? calls.get(item.id) : undefined
		if (call && item.type === 'tool-result') {
			call.result = item
			continue
		}
		let row: Row = { item, at }
		if (item.type === 'tool') calls.set(item.id, row)
		out.push(row)
	}
	return out
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, ' ').trim()
}

function show(item: Item): Shown {
	switch (item.type) {
		case 'prompt':
			return { kind: 'user', text: item.text }
		case 'text':
			return { kind: 'assistant', text: item.text }
		case 'thinking':
			return { kind: 'thinking', text: item.text }
		case 'tool': {
			let kind = `tool tool-${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
			let { command, description } = item.input
			if (typeof command === 'string' && typeof description === 'string')
				return { kind, text: `▸ ${oneLine(description)}\n  $ ${command}` }
			return { kind, text: `▸ ${item.name} ${JSON.stringify(item.input)}` }
		}
		case 'tool-result': {
			// A glimpse, like the terminal: the model sees all of it.
			let rows = item.output.replace(/\n$/, '').split('\n')
			let shown = rows.slice(0, view.resultRows())
			if (rows.length > shown.length) shown.push(`… ${rows.length - shown.length} more lines`)
			return { kind: item.isError ? 'result error' : 'result log', text: (item.isError ? '✗ ' : '◂ ') + shown.join('\n  ') }
		}
		case 'turn-end':
			if (item.status === 'error') return { kind: 'end error', text: `error: ${item.error ?? 'turn failed'}` }
			if (item.status === 'completed') return null
			return { kind: 'end log', text: `[${item.status}]` }
		case 'question': {
			let said = item.cancelled ? ['(cancelled)'] : item.answers ? forms.summary(item.form, item.answers, item.secrets) : ['(not answered)']
			let quote = item.form.quote ? item.form.quote.text.split('\n').map((l) => `    ${l}`) : []
			return { kind: 'question warning', text: [`? ${item.form.text}`, ...quote, ...said.map((l) => `  ${l}`)].join('\n') }
		}
		case 'command':
			return { kind: 'user', text: item.from === undefined ? item.text : `${item.text}\n(sent from ${item.from})` }
		case 'output':
			return { kind: item.error ? 'output error' : 'output log', text: item.text }
	}
}

export const view = {
	// Rows of a tool result shown in the transcript.
	resultRows: () => 8,
	onEvent,
	key,
	formKey,
	modelsKey,
	modalKey,
	search,
	submit,
	editKey,
	notice,
	complete,
	completed,
	pause,
	inbox: waiting,
	thinking,
	line,
	hints,
	rows,
	markRow,
	show,
}
