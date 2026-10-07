// The browser client's state, without the DOM: the transcript folded
// from host events (the same transcript.fold the terminal uses), a
// passing notice, and what each item looks like as text. app.ts feeds
// it the events from link.ts; the components draw it.
// Tasks: dz, a1k, kx0.

import { queueEdit } from '../common/queue-edit.ts'
import { completions, type Menu } from './completions.ts'
import { amend, type Editing } from '../common/amend.ts'
import { attachments } from '../common/attachments.ts'
import { bashResult } from '../common/bash-result.ts'
import { commandList } from '../common/commands/list.ts'
import { completion } from '../common/completion.ts'
import { forms, type FormState, type Key } from '../common/forms.ts'
import { inbox, type InboxItem } from '../common/inbox.ts'
import { modals, type ModalState } from '../common/modals.ts'
import { picker } from '../common/picker.ts'
import { settingsModal } from '../common/settings-modal.ts'
import type { Delivery, Event } from '../common/protocol.ts'
import { sendKeys } from '../common/send-keys.ts'
import { states } from '../common/states.ts'
import { transcript, type Item, type Shown as ItemShown, type Transcript } from '../common/transcript.ts'
import { titles } from '../common/titles.ts'
import { summary } from '../common/summary.ts'
import { toolDetails } from '../common/tool-details.ts'
import { promptChanges } from '../common/prompt-changes.ts'

// `form`: the open question as filled in on this page.
// `editing`: the last prompt is in the input (src/common/amend.ts).
// `modal`: the model picker over the page, taking the keys first;
// `models` the host's full list it filters.
// `sent`: the command id of each prompt or slash command this client
// sent, by its item's key, so its row keeps the key it had while pending
// (and its card moves, not remounts, to where the host put it, task rk)
// (showing another tab starts a new view state, and a new map).
export type ViewState = { transcript?: Transcript; notice?: string; form?: FormState; editing?: Editing; modal?: ModalState; models?: string[]; names?: Record<string, string>; sent?: Record<string, string> }

// One transcript item as shown: CSS classes and its text. The classes
// are theme style names (src/common/colors.ts in kebab case), whose CSS
// the host puts in the page. Null shows
// nothing (a completed turn end).
export type Shown = { kind: string; text: string } | null

function onEvent(st: ViewState, event: Event): ViewState {
	if (event.type === 'rejected') return { ...st, notice: `${event.command} refused: ${event.reason}` }
	if (event.type === 'warning') return { ...st, notice: event.text }
	if (event.type === 'model-names') {
		titles.learn(event)
		return { ...st }
	}
	if (event.type === 'models') {
		if (event.sessionId !== st.transcript?.meta.id || (event.refresh && !st.modal?.tree)) return st
		let modal = event.refresh ? picker.refresh(st.modal!, event.items, event.names, event.capabilities) : picker.open(event.current, event.items, event.names, event.capabilities, event.effort)
		return { ...st, modal, models: event.items, names: event.names ?? {} }
	}
	if (event.type === 'restart-ask') return { ...st, modal: modals.restart(event.scope, event.calls) }
	if (event.type === 'settings') {
		if (event.refresh) return st.modal?.settings ? { ...st, modal: settingsModal.refresh(st.modal, event) } : st
		return event.sessionId === st.transcript?.meta.id ? { ...st, modal: settingsModal.open(event) } : st
	}
	let t = transcript.fold(st.transcript, event)
	if (t === st.transcript) return st
	let next: ViewState = { ...st, transcript: t }
	if ((event.type === 'turn-start' || event.type === 'prompt' || event.type === 'command') && event.command && event.n !== undefined) {
		let at = event.type === 'prompt' ? event.texts.length - 1 : 0
		next.sent = { ...st.sent, [transcript.key(event.n, at, 0)]: event.command }
	}
	let form = forms.follow(st.form, transcript.question(t))
	if (form) next.form = form
	else delete next.form
	return next
}

// A browser key as a form key, or undefined for keys forms ignore.
// With Alt, macOS types a symbol (Option-D is ∂): the physical key's
// letter names it then.
function key(e: { key: string; code?: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): Key | undefined {
	let names: Record<string, string> = { F1: 'f1', Enter: 'enter', Escape: 'escape', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Backspace: 'backspace', Delete: 'delete', Home: 'home', End: 'end' }
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

// A host command's key (common/commands/list.ts), if the browser gives
// it to the page: what to send. Ctrl-M only asks for the model picker;
// others send `/<name>` as typed. Client-only commands are the
// terminal's; the tab keys are tabs.ts, sent unrecorded. Ctrl-L (redraw)
// is the terminal's local repaint: the page has nothing to repaint, and
// sending it would record a /redraw prompt.
const tabKeys = new Set(['new', 'close', 'resume'])

function commandKey(st: ViewState, k: Key, mac: boolean): unknown {
	let c = commandList.byKey({ key: k.key, shift: !!k.shift, alt: !!k.alt, ctrl: !!k.ctrl, cmd: !!k.cmd })
	if (!c || c.clientOnly || tabKeys.has(c.name) || c.name === 'restart' || c.name === 'redraw' || !commandList.onWeb(c.key!, mac) || !st.transcript) return undefined
	let sessionId = st.transcript.meta.id
	return c.name === 'model' ? { type: 'models', sessionId } : { type: 'submit', sessionId, text: `/${c.name}` }
}

function closed(st: ViewState): ViewState {
	let { modal: _m, models: _l, names: _n, ...rest } = st
	return rest
}

// A key on the open modal: the view after and the command Enter sends.
function modalKey(st: ViewState, k: Key): { state: ViewState; command?: unknown } {
	if (!st.modal || !st.transcript) return { state: st }
	let { state, action } = st.modal.settings ? settingsModal.step(st.modal, k, st.transcript.meta.id) : st.modal.restart ? modals.step(st.modal, k) : picker.step(st.modal, k, st.models ?? [], st.names)
	if (!action) return { state: { ...st, modal: state } }
	if (action.type === 'send') return { state: { ...st, modal: state }, command: action.command }
	let command = state.restart ? modals.restartCommand(state, action, st.transcript.meta.id) : action.type === 'submit' ? picker.command(st.transcript.meta.id, state, action) : undefined
	return command ? { state: closed(st), command } : { state: closed(st) }
}

// The search box, or with `edit` the /config edit field, now says `text`
// (typed natively in its input).
function search(st: ViewState, text: string, edit = false): ViewState {
	if (!st.modal?.form) return st
	if (st.modal.settings) return { ...st, modal: edit ? settingsModal.edited(st.modal, text) : settingsModal.search(st.modal, text) }
	let modal = { ...st.modal, form: forms.set(st.modal.form, 0, text), selected: 0, scroll: 0 }
	return { ...st, modal: picker.refilter(modal, st.models ?? [], st.names) }
}

// What Enter with `text` does: send a prompt (steering a busy turn;
// `queue`, Alt-Enter: after it), a continue (empty, on a paused or
// failed turn), or show why not (the typed text stays).
// While editing a prompt, Enter sends the edit; emptied, an edit from
// an Edit button cancels (task 26q).
function submit(st: ViewState, text: string, delivery: Delivery = 'steer'): { command?: unknown; notice?: string; keep: boolean } {
	if (st.editing) {
		let command = st.editing.aside && !text.trim() ? amend.resume(st.editing, st.transcript) : amend.enter(st.editing, st.transcript, text, delivery === 'queue')
		return command ? { command, keep: false } : { keep: false }
	}
	if (!st.transcript) return text.trim() ? { notice: 'no session yet', keep: true } : { keep: false }
	let { command, refused } = states.enter(st.transcript.meta.id, st.transcript.state, text, delivery, st.transcript.inbox.some((m) => m.queue))
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
	if (!editing || editing.aside || (key === 'down' && text !== editing.original)) return undefined
	let command = amend.resume(editing, st.transcript)
	let out: { view: ViewState; command?: unknown; text: string } = { view: { ...st, editing: undefined }, text: text === editing.original ? '' : text }
	if (command) out.command = command
	return out
}

// The passing notice, else the hint while editing the last prompt.
function notice(st: ViewState): string | undefined {
	return st.notice ?? (st.transcript && queueEdit.notice(st.transcript)) ?? (st.editing && !st.editing.aside ? amend.hint(st.editing) : undefined)
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

// Prompts Play sends when an idle turn ended with the assistant's text
// (task yhn): a few words, each asking for action, not another plan.
const NUDGES = ['Continue.', 'Proceed.', 'Go on.', 'Keep going.', 'Carry on.', 'Go ahead.', 'Finish it.', 'You can do it.', 'Onward!']

// A nudge if the session is idle and its last output is the assistant's text.
function nudge(st: ViewState, pick = Math.random()): string | undefined {
	let t = st.transcript
	if (t?.state.type !== 'idle') return undefined
	let last = t.items.findLast((i) => i.type !== 'turn-end' && i.type !== 'thinking')
	return last?.type === 'text' ? NUDGES[Math.floor(pick * NUDGES.length)] : undefined
}

// What the model is streaming into the last item, thinking or text:
// Hal's cursor sits in that item's card (dimmed while thinking).
function streaming(st: ViewState): 'thinking' | 'text' | undefined {
	let t = st.transcript
	let last = t?.items.at(-1)?.type
	if (t?.state.type !== 'running' || t.state.phase !== 'streaming') return undefined
	return last === 'thinking' || last === 'text' ? last : undefined
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
	if (queueEdit.waiting(t)) return { text: 'waiting for queue edit', tone: 'warn' }
	if (s.type === 'idle') return { text: 'idle', tone: 'idle' }
	let text = states.describe(s, undefined, t.items) ?? ''
	return { text, tone: s.type === 'error' ? 'error' : s.type === 'running' || s.type === 'retrying' ? 'busy' : 'warn' }
}

// The web help row: the shared state hints (sendKeys.hints), or the
// keys of the completion menu or a queue edit, which only the web has.
function hints(st: ViewState, text = '', menu?: Menu): [string, string][] {
	if (st.editing?.queueEdit) return [['enter', 'save queue edit'], ['shift-enter', 'newline'], ['esc', 'cancel']]
	if (!menu) return sendKeys.hints(st.transcript?.state, text)
	let busy = !!st.transcript && states.busy(st.transcript.state)
	let command = sendKeys.commandDraft(text)
	let enter = completions.chooses(text, menu) ? 'choose' : command ? 'run' : busy ? 'steer' : 'send'
	let queue: [string, string][] = busy && !command && sendKeys.key('queue') ? [[sendKeys.key('queue')!, 'queue']] : []
	return [['enter', enter], ['↑/↓', 'select'], ['tab', 'complete'], ['shift-enter', 'newline'], ...queue, ['esc', 'dismiss']]
}

// A transcript row: an item, and for a tool call its result once it
// came. Rows only grow at the end as items do (a result joins its
// call's row), so rows keyed by position keep their DOM.
// `key`: what keeps the row's card (task w5): the item's key, or for a
// prompt or command this client sent, the command id it had while pending.
// `pending`: sent, not yet acknowledged. `waiting`: in the inbox;
// `note`: a queued message's compact row starts with it (task 16).
export type Row = { item: Item; at: number; key: string; result?: Item & { type: 'tool-result' }; pending?: true; waiting?: true; note?: string }

function rows(items: Item[], sent: Record<string, string> = {}): Row[] {
	let out: Row[] = []
	let calls = new Map<string, Row>()
	items = promptChanges.group(items)
	for (let [at, item] of items.entries()) {
		if (item.type === 'turn-end' && item.status === 'completed') continue
		// Thinking with no readable text (redacted or empty) is no card,
		// unless it is the last item, which may be streaming (task hp).
		if (item.type === 'thinking' && !item.text.trim() && at < items.length - 1) continue
		let call = item.type === 'tool-result' ? calls.get(item.id) : undefined
		if (call && item.type === 'tool-result') {
			call.result = item
			continue
		}
		let row: Row = { item, at, key: sent[item.key] ?? item.key }
		if (item.type === 'tool') calls.set(item.id, row)
		out.push(row)
	}
	return out
}

// `rows` and after them the prompts still pending (`id`: the submit's
// command id), but for one the host already put in the transcript: it
// is a row already, under the same key, so its card stays. `tabs`: the
// host's tab ids in order, numbering a queued message's sender.
function withPending(rows: Row[], pending: { id: string; text: string; ts?: string }[], waiting: InboxItem[] = [], tabs: string[] = [], held?: string): Row[] {
	let keys = new Set(rows.map((r) => r.key))
	let at = (rows.at(-1)?.at ?? -1) + 1
	let row = (m: InboxItem): Row => {
		let r: Row = { item: transcript.waitingItem(m), at, key: m.id, waiting: true }
		if (m.queue) r.note = inbox.note(m, m.from === undefined ? undefined : tabs.indexOf(m.from) + 1 || undefined, m.id === held)
		return r
	}
	let queued = waiting.filter((m) => !keys.has(m.id)).map(row)
	for (let row of queued) keys.add(row.key)
	let more = pending.filter((s) => !keys.has(s.id)).map((s): Row => ({ item: { type: 'prompt', text: s.text, ts: s.ts, key: s.id }, at, key: s.id, pending: true }))
	return queued.length || more.length ? [...rows, ...queued, ...more] : rows
}

// Keys of the background Bash calls whose job still runs: started (the
// result says so) and no 'bash #<key>' message has come back. The host
// refuses /kill for one that has just ended.
function jobs(rows: Row[]): ReadonlySet<string> {
	let done = new Set(rows.flatMap((r) => (r.item.type === 'prompt' && r.item.label?.startsWith('bash #') ? [r.item.label.slice(6).replace(/^t/, '')] : [])))
	let out = new Set<string>()
	for (let r of rows) {
		let n = r.result?.output.match(/^started in background as #t?(\d+)/)?.[1]
		if (n && !done.has(n)) out.add(n)
	}
	return out
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, ' ').trim()
}

// `full`: a tool result's whole output, not its glimpse.
function show(item: ItemShown, full = false, bash = false): Shown {
	switch (item.type) {
		case 'prompt':
			// Who sent it is in the card's head (task hp); a report's
			// summary heads its card, so the body omits the tag (task rj).
			return { kind: titles.letter(item) === 'm' ? 'message prompt' : 'user prompt', text: bashResult.background(item) ? bashResult.display(item.text) : item.report ? summary.answer(item.text) : item.summary ? summary.strip(item.text) : item.text }
		case 'image':
			// The text is the image's alt text; Card shows the image.
			return { kind: 'user image', text: attachments.label(item) }
		case 'text':
			return { kind: 'assistant', text: summary.answer(item.text) }
		case 'thinking':
			return { kind: 'thinking', text: item.text }
		case 'tool': {
			let kind = `tool tool-${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
			let { command, description } = item.input
			if (typeof command === 'string' && typeof description === 'string')
				return { kind, text: `▸ ${oneLine(description)}\n  ${item.input.background === true ? '&' : '$'} ${command}` }
			return { kind, text: `▸ ${toolDetails.headline(item.name, item.input).text}` }
		}
		case 'tool-result': {
			// A glimpse, like the terminal; steering's note is the header's (ker).
			if (item.interrupted === 'canceled') return { kind: 'result log', text: '' }
			let rows = (item.interrupted ? bashResult.display(item.output, true) : bash ? bashResult.display(item.output) : item.output).replace(/\n$/, '').split('\n')
			let shown = full ? rows : rows.slice(0, view.resultRows)
			if (rows.length > shown.length) shown.push(`… ${rows.length - shown.length} more lines`)
			return { kind: item.isError ? 'result error' : 'result log', text: (item.isError ? '✗ ' : '◂ ') + shown.join('\n  ') }
		}
		case 'turn-end':
			if (item.status === 'error') return { kind: 'end error', text: titles.stamp(item.ts, `error: ${item.error ?? 'turn failed'}`) }
			if (item.status === 'completed') return null
			return { kind: 'end log', text: titles.ended(item.ts, item.status) }
		case 'question': {
			let said = item.canceled ? ['(canceled)'] : item.answers ? forms.summary(item.form, item.answers, item.secrets) : ['(not answered)']
			let quote = item.form.quote ? [...item.form.quote.text.split('\n').map((l) => `    ${l}`), ''] : []
			return { kind: 'question warning', text: [...quote, ...said.map((l) => `  ${l}`)].join('\n') }
		}
		case 'command':
			// Drawn as the prompt it was typed as (Card heads it).
			return { kind: item.from === undefined ? 'user prompt' : 'message prompt', text: item.text }
		case 'output':
			// A prompt-file change: the summary heads its card, so the body
			// is the diffs (task ar).
			return { kind: item.error ? 'output error' : item.synthetic ? 'output synthetic' : 'output log', text: item.change ? item.text.slice(item.text.indexOf('\n') + 1).trimStart() : item.text }
		case 'divider':
			return { kind: 'divider log', text: titles.stamp(item.ts, item.text) }
	}
}

export const view = {
	// Rows of a tool result shown in the transcript.
	resultRows: 8,
	onEvent,
	key,
	formKey,
	commandKey,
	modalKey,
	search,
	submit,
	editKey,
	notice,
	complete,
	completed,
	pause,
	nudge,
	streaming,
	line,
	hints,
	commandDraft: sendKeys.commandDraft,
	rows,
	withPending,
	jobs,
	show,
}
