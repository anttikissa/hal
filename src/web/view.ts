// The browser client's state, without the DOM: the transcript folded
// from host events (the same transcript.fold the terminal uses), a
// passing notice, and what each item looks like as text. app.ts feeds
// it the events from link.ts; the components draw it.

import { amend, type Editing } from '../common/amend.ts'
import { attachments } from '../common/attachments.ts'
import { bashResult } from '../common/bash-result.ts'
import { commandList } from '../common/commands/list.ts'
import { completion } from '../common/completion.ts'
import { forms, type FormState, type Key } from '../common/forms.ts'
import { inbox } from '../common/inbox.ts'
import type { ModalState } from '../common/modals.ts'
import { picker } from '../common/picker.ts'
import type { Event } from '../common/protocol.ts'
import { states } from '../common/states.ts'
import { transcript, type Item, type Shown as ItemShown, type Transcript } from '../common/transcript.ts'
import { titles } from '../common/titles.ts'
import { summary } from '../common/summary.ts'

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
		Object.assign(titles.names, event.names)
		return { ...st }
	}
	if (event.type === 'models') return event.sessionId === st.transcript?.meta.id ? { ...st, modal: picker.open(event.current, event.items, event.names), models: event.items, names: event.names ?? {} } : st
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
// terminal's (the web's tab keys are shortcuts.ts).
function commandKey(st: ViewState, k: Key, mac: boolean): unknown {
	let c = commandList.byKey({ key: k.key, shift: !!k.shift, alt: !!k.alt, ctrl: !!k.ctrl, cmd: !!k.cmd })
	if (!c || c.clientOnly || !commandList.onWeb(c.key!, mac) || !st.transcript) return undefined
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
	let { state, action } = picker.step(st.modal, k, st.models ?? [], st.names)
	if (!action) return { state: { ...st, modal: state } }
	let command = action.type === 'submit' ? picker.command(st.transcript.meta.id, state, action) : undefined
	return command ? { state: closed(st), command } : { state: closed(st) }
}

// The search box now says `text` (typed natively in its input).
function search(st: ViewState, text: string): ViewState {
	if (!st.modal?.form) return st
	let modal = { ...st.modal, form: forms.set(st.modal.form, 0, text), selected: 0, scroll: 0 }
	return { ...st, modal: picker.refilter(modal, st.models ?? [], st.names) }
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

// The passing notice, else the hint while editing the last prompt.
function notice(st: ViewState): string | undefined {
	return st.notice ?? (st.editing && amend.hint(st.editing))
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
	return t ? t.inbox.map((m) => ({ text: m.text, label: inbox.tag(m) })) : []
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
	if (s.type === 'idle') return { text: 'idle', tone: 'idle' }
	let text = states.describe(s, undefined, t.items) ?? ''
	return { text, tone: s.type === 'error' ? 'error' : s.type === 'running' || s.type === 'retrying' ? 'busy' : 'warn' }
}

// The web status row's facts, in display order. A group never drops for
// space: the CSS wraps it on narrow screens. Heat classes come from the
// theme generated by the host, not browser-side colour literals.
export type StatusPart = { text: string; heat?: 'cool' | 'warm' | 'hot' }
// `path`: cut from the start when too wide, keeping the directory's name.
export type StatusGroup = { parts: StatusPart[]; path?: true }

function status(st: ViewState): StatusGroup[] {
	let t = st.transcript
	if (!t) return []
	let { meta, stats } = t
	let count = (n: number) => n < 1000 ? `${n}` : n < 9950 ? `${(n / 1000).toFixed(1)}k` : n < 999500 ? `${Math.round(n / 1000)}k` : n < 9950000 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e6)}M`
	let kilo = (n: number) => n < 1000 ? String(n) : `${Math.round(n / 1000)}k`
	let heat = (percent: number): StatusPart['heat'] => percent >= 85 ? 'hot' : percent >= 60 ? 'warm' : 'cool'
	let groups: StatusGroup[] = [
		{ parts: [{ text: meta.id }, ...(meta.name ? [{ text: `: ${meta.name}` }] : [])] },
		{ parts: [{ text: meta.cwd }], path: true },
		{ parts: [{ text: titles.modelName(meta.model) }] },
	]
	if (stats?.window) {
		let percent = Math.round((stats.context ?? 0) / stats.window * 100)
		groups.push({ parts: [{ text: `${kilo(stats.context ?? 0)}/${kilo(stats.window)} (` }, { text: `${percent}%`, heat: heat(percent) }, { text: ')' }] })
	} else if (stats?.context) groups.push({ parts: [{ text: kilo(stats.context) }] })
	if (stats) groups.push({ parts: [{ text: `↑${count(stats.sent)} ↓${count(stats.received)}` }] })
	if (stats?.plan) {
		let plan = stats.plan
		let parts: StatusPart[] = [{ text: `Sub${plan.accounts > 1 ? ` ${plan.account}/${plan.accounts}` : ''}` }]
		for (let [name, percent] of Object.entries(plan.windows)) parts.push({ text: `${parts.length === 1 ? ': ' : ', '}${name} ` }, { text: `${percent}%`, heat: heat(percent) })
		groups.push({ parts })
	}
	return groups
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
// `key`: what keeps the row's card (task w5): the item's key, or for a
// prompt or command this client sent, the command id it had while pending.
// `pending`: sent, not yet acknowledged.
export type Row = { item: Item; at: number; key: string; result?: Item & { type: 'tool-result' }; pending?: true }

function rows(items: Item[], sent: Record<string, string> = {}): Row[] {
	let out: Row[] = []
	let calls = new Map<string, Row>()
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
// is a row already, under the same key, so its card stays.
function withPending(rows: Row[], pending: { id: string; text: string }[]): Row[] {
	let keys = new Set(rows.map((r) => r.key))
	let at = (rows.at(-1)?.at ?? -1) + 1
	let more = pending.filter((s) => !keys.has(s.id)).map((s): Row => ({ item: { type: 'prompt', text: s.text, key: s.id }, at, key: s.id, pending: true }))
	return more.length ? [...rows, ...more] : rows
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, ' ').trim()
}

// `full`: a tool result's whole output, not its glimpse.
function show(item: ItemShown, full = false, bash = false): Shown {
	switch (item.type) {
		case 'prompt':
			// Who sent it is in the card's head (task hp).
			return { kind: 'user prompt', text: (/^bash (?:#\d+|b[0-9a-f]{6})$/.test(item.label ?? '')) ? bashResult.display(item.text) : item.text }
		case 'image':
			// The text is the image's alt text; Card shows the image.
			return { kind: 'user image', text: attachments.label(item) }
		case 'text':
			return { kind: 'assistant', text: summary.strip(item.text) }
		case 'thinking':
			return { kind: 'thinking', text: item.text }
		case 'tool': {
			let kind = `tool tool-${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
			let { command, description } = item.input
			if (typeof command === 'string' && typeof description === 'string')
				return { kind, text: `▸ ${oneLine(description)}\n  ${item.input.background === true ? '&' : '$'} ${command}` }
			return { kind, text: `▸ ${item.name} ${JSON.stringify(item.input)}` }
		}
		case 'tool-result': {
			// A glimpse, like the terminal: the model sees all of it.
			let rows = (bash ? bashResult.display(item.output) : item.output).replace(/\n$/, '').split('\n')
			let shown = full ? rows : rows.slice(0, view.resultRows())
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
			// Drawn as the prompt it was typed as (Card heads it).
			return { kind: 'user prompt', text: item.text }
		case 'output':
			return { kind: item.error ? 'output error' : 'output log', text: item.text }
		case 'divider':
			return { kind: 'divider log', text: item.text }
	}
}

// A prompt's text in parts, each [image/<name>] or [paste/<name>]
// marker a link to its page (tasks qy, 31).
function links(text: string): (string | { href: string; text: string })[] {
	let out: (string | { href: string; text: string })[] = []
	let from = 0
	for (let m of text.matchAll(attachments.fileMarker)) {
		if (m.index > from) out.push(text.slice(from, m.index))
		out.push({ href: `/${m[1]!}`, text: m[0] })
		from = m.index + m[0].length
	}
	if (from < text.length) out.push(text.slice(from))
	return out
}

// Where the page loads a session's image from (host/web.ts).
function blobUrl(sessionId: string, blob: string): string {
	return `/blob/${encodeURIComponent(sessionId)}/${encodeURIComponent(blob)}`
}

export const view = {
	blobUrl,
	links,
	// Rows of a tool result shown in the transcript.
	resultRows: () => 8,
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
	inbox: waiting,
	streaming,
	line,
	status,
	hints,
	rows,
	withPending,
	show,
}
