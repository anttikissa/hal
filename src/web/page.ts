/// <reference lib="dom" />
// The browser client's page: a password form until the cookie is set,
// then one session's transcript above a textarea. Enter submits
// (steering a running turn; Alt+Enter queues after it, Shift+Enter is a
// newline), Escape pauses a running turn, Up on an empty input edits
// the last prompt (src/common/amend.ts). Waiting messages (the inbox)
// always show above the input. The textarea is the session's draft
// (common/drafts.ts, kept in localStorage too); a sent prompt shows at
// once, pending until the host has it, connected or not. Plain DOM;
// web.ts bundles this file into index.html at request time.

import { forms, type FormAction } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import { transcript, type Item } from '../common/transcript.ts'
import { connection, type LinkState } from '../common/connection.ts'
import { drafts, type Local } from '../common/drafts.ts'
import { link } from './link.ts'
import { view, type ViewState } from './view.ts'

type PageState = {
	view: ViewState
	// Transcript items on screen and their nodes, in order; `open` if
	// drawn as the form being filled in.
	drawn: { item: Item; node: HTMLElement | null; open: boolean }[]
	// The open form's field elements (an input, or a group of buttons).
	fields: HTMLElement[]
	log: HTMLElement | null
	// The line marking where replayed history ends.
	resumed: HTMLElement | null
	notice: HTMLElement | null
	inbox: HTMLElement | null
	// Prompts sent and not yet acknowledged, after the transcript.
	pending: HTMLElement | null
	input: HTMLTextAreaElement | null
}

function createState(): PageState {
	return { view: {}, drawn: [], fields: [], log: null, resumed: null, notice: null, inbox: null, pending: null, input: null }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
	return Object.assign(document.createElement(tag), props)
}

// Redraws only from the first item that changed: settled items keep
// their identity across folds, the running turn's items do not.
function draw(): void {
	let st = page.state
	let log = st.log!
	let atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
	let items = st.view.transcript?.items ?? []
	let isOpen = (item: Item) => item.type === 'question' && item.id === st.view.form?.id
	let first = 0
	while (first < items.length && first < st.drawn.length && items[first] === st.drawn[first]!.item && isOpen(items[first]!) === st.drawn[first]!.open) first++
	for (let d of st.drawn.splice(first)) d.node?.remove()
	for (let item of items.slice(first)) {
		let open = isOpen(item)
		let shown = view.show(item)
		let node = open && item.type === 'question' ? page.formNode(item) : shown ? el('div', { className: shown.kind, textContent: shown.text }) : null
		if (node) log.append(node)
		st.drawn.push({ item, node, open })
	}
	if (!st.drawn.some((d) => d.open)) st.fields = []
	let resumed = st.view.resumed
	if (resumed) {
		st.resumed ??= el('div', { className: 'log' })
		st.resumed.textContent = transcript.resumedLabel(resumed)
		let next = st.drawn.slice(resumed.at).find((d) => d.node)?.node
		if (next) log.insertBefore(st.resumed, next)
		else log.append(st.resumed)
	} else st.resumed?.remove()
	st.inbox!.replaceChildren(...view.inbox(st.view).map((m) => el('div', { className: 'log', textContent: `${m.label}: ${m.text}` })))
	let id = st.view.transcript?.meta.id
	st.pending ??= el('div', { className: 'log' })
	st.pending.replaceChildren(...(id ? drafts.pending(id) : []).map((text) => el('div', { className: 'user pending', textContent: text })))
	st.pending.style.display = 'contents'
	log.append(st.pending)
	st.notice!.textContent = view.notice(st.view) ?? ''
	// The open question owns input; the message box waits, keeping its text.
	let wasDisabled = st.input!.disabled
	st.input!.disabled = !!st.view.form
	if (st.view.form) page.syncForm()
	else if (wasDisabled) st.input!.focus()
	let status = view.status(st.view)
	st.input!.placeholder = status ? `${status}; Enter steers, Alt+Enter queues, Escape pauses` : 'Message Hal (Enter sends, Shift+Enter for a newline)'
	if (atBottom) log.scrollTop = log.scrollHeight
}

// The open question as a form: a text or password input per text
// field, a button per option. Values and focus follow the shared form
// state (syncForm); keys go through forms.step like the terminal's.
function formNode(item: Item & { type: 'question' }): HTMLElement {
	let st = page.state
	let box = el('form', { className: 'question warning' })
	box.append(el('div', { textContent: `? ${item.form.text}` }))
	// The quote (a command to approve) with its marked parts highlighted.
	if (item.form.quote) {
		let pre = el('pre', { className: 'quote' })
		for (let part of forms.quoteParts(item.form.quote)) pre.append(part.marked ? el('mark', { textContent: part.text }) : part.text)
		box.append(pre)
	}
	st.fields = item.form.fields.map((f, i) => {
		let label = f.label ?? item.form.text
		if (f.type === 'choice') {
			let group = el('div', { role: 'group', ariaLabel: label } as Partial<HTMLElement>)
			if (f.label) group.append(`${f.label}: `)
			for (let option of f.options) {
				let button = el('button', { type: 'button', textContent: option, value: option })
				button.addEventListener('click', () => page.pick(i, option))
				group.append(button, ' ')
			}
			box.append(group)
			return group
		}
		let input = el('input', { type: f.type === 'secret' ? 'password' : 'text', ariaLabel: label, autocomplete: 'off', className: 'input' })
		if (f.type === 'text' && f.placeholder) input.placeholder = f.placeholder
		input.addEventListener('input', () => {
			if (st.view.form) st.view = { ...st.view, form: forms.set(st.view.form, i, input.value) }
		})
		input.addEventListener('focus', () => {
			if (st.view.form && st.view.form.focus !== i) st.view = { ...st.view, form: forms.focusOn(st.view.form, i) }
		})
		let row = el('label')
		if (f.label) row.append(`${f.label}: `)
		row.append(input)
		box.append(row)
		return input
	})
	if (item.form.fields.some((f) => f.type !== 'choice') || item.form.fields.length > 1) box.append(el('button', { textContent: 'Answer' }))
	box.addEventListener('submit', (e) => {
		e.preventDefault()
		let form = st.view.form
		if (form) page.sendForm({ type: 'submit', answers: forms.answers(form) })
	})
	return box
}

// Shows the form state in its elements and focuses the focused field.
function syncForm(): void {
	let st = page.state
	let form = st.view.form
	if (!form) return
	st.fields.forEach((node, i) => {
		let value = form.values[i]!
		if (node instanceof HTMLInputElement) {
			if (node.value !== value) node.value = value
		} else for (let b of node.querySelectorAll('button')) b.ariaPressed = String(b.value === value)
		if (i !== form.focus || node.contains(document.activeElement)) return
		let target = node instanceof HTMLInputElement ? node : [...node.querySelectorAll('button')].find((b) => b.value === value)
		target?.focus()
	})
}

// A click on an option: choose it; on a one-field form that answers.
function pick(index: number, option: string): void {
	let st = page.state
	if (!st.view.form) return
	let form = forms.set(st.view.form, index, option)
	st.view = { ...st.view, form }
	if (form.form.fields.length === 1) page.sendForm({ type: 'submit', answers: forms.answers(form) })
	else page.syncForm()
}

function sendForm(action: FormAction): void {
	let st = page.state
	if (!st.view.form || !st.view.transcript) return
	if (!connection.connected()) return page.setNotice('not connected; try again in a moment')
	connection.send(forms.command(st.view.transcript.meta.id, st.view.form, action))
}

function onEvent(event: Event): void {
	let st = page.state
	let changed = drafts.onEvent(event)
	st.view = view.onEvent(st.view, event)
	let id = st.view.transcript?.meta.id
	if (id && (changed || event.type === 'snapshot') && st.input!.value !== drafts.text(id)) {
		st.input!.value = drafts.text(id)
		page.fitInput()
	}
	page.draw()
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

function onInput(): void {
	let id = page.state.view.transcript?.meta.id
	if (id) drafts.edit(id, page.state.input!.value)
	page.fitInput()
}

function setNotice(notice: string | undefined): void {
	page.state.view = { ...page.state.view, notice }
	page.draw()
}

function onState(state: LinkState): void {
	page.setNotice(state.type === 'connected' ? undefined : state.type === 'joining' ? 'connecting…' : 'disconnected; reconnecting…')
}

function fitInput(): void {
	let input = page.state.input!
	input.style.height = 'auto'
	input.style.height = `${Math.min(input.scrollHeight + 2, innerHeight / 3)}px`
}

function onKey(e: KeyboardEvent): void {
	let st = page.state
	if (e.isComposing) return
	if (st.view.form) {
		let k = view.key(e)
		// Text fields edit natively; the shared form keys decide the rest.
		let native = e.target instanceof HTMLInputElement && !['enter', 'escape', 'tab', 'up', 'down'].includes(k?.key ?? '')
		if (!k || native || (e.target instanceof HTMLButtonElement && e.key === 'Enter' && e.target.type !== 'button')) return
		e.preventDefault()
		let { state, command } = view.formKey(st.view, k)
		st.view = state
		if (command && !connection.connected()) page.setNotice('not connected; try again in a moment')
		else if (command) connection.send(command)
		page.syncForm()
		return
	}
	// Editing the last prompt: Up loads it, Down (unchanged) or Escape
	// leaves; the input stays the draft.
	let arrow = { ArrowUp: 'up', ArrowDown: 'down', Escape: 'escape' } as const
	let editKey = e.key in arrow && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && e.target === st.input
	let edit = editKey ? view.editKey(st.view, arrow[e.key as keyof typeof arrow], st.input!.value) : undefined
	if (edit) {
		e.preventDefault()
		st.view = edit.view
		st.input!.value = edit.text
		if (edit.command) connection.send(edit.command)
		page.onInput()
		page.draw()
		return
	}
	if (e.key === 'Escape') {
		let command = view.pause(st.view)
		if (command) connection.send(command)
		return
	}
	if (e.key !== 'Enter' || e.shiftKey || e.target !== st.input) return
	e.preventDefault()
	let { command, notice, keep } = view.submit(st.view, st.input!.value, e.altKey)
	let c = command as { type: string; sessionId: string; text?: string; queue?: boolean; amend?: boolean } | undefined
	// A prompt shows at once and waits, pending, for the host.
	if (c?.type === 'submit') drafts.submit(c.sessionId, c.text!, c.queue, c.amend)
	else if (c) connection.send(c)
	if (!keep) {
		st.input!.value = ''
		st.view = { ...st.view, editing: undefined }
	}
	page.setNotice(notice)
	page.fitInput()
}

function chat(): void {
	let st = page.state
	document.body.replaceChildren()
	st.log = el('main', { role: 'log' } as Partial<HTMLElement>)
	st.notice = el('div', { id: 'notice', className: 'log' })
	st.inbox = el('div', { id: 'inbox' })
	st.input = el('textarea', { rows: 1, autofocus: true, ariaLabel: 'Message', className: 'input' })
	st.input.addEventListener('input', () => page.onInput())
	let footer = el('footer')
	footer.append(st.inbox, st.notice, st.input)
	document.body.append(st.log, footer)
	document.addEventListener('keydown', (e) => page.onKey(e))
	st.input.focus()
	drafts.store = store
	page.draw()
	let scheme = location.protocol === 'https:' ? 'wss' : 'ws'
	link.start({
		dial: () => new WebSocket(`${scheme}://${location.host}/ws`),
		onEvent: (e) => page.onEvent(e),
		onState: (s) => page.onState(s),
	})
	// The newest session, or a new one in the host's working directory;
	// after a reconnect the connection re-opens the one on screen.
	connection.send({ type: 'open-newest' })
}

function loginForm(): void {
	let form = el('form')
	let input = el('input', { type: 'password', name: 'password', placeholder: 'Password', autofocus: true, ariaLabel: 'Password' })
	let status = el('div', { id: 'notice', className: 'log' })
	form.append(input, el('button', { textContent: 'Log in' }), status)
	form.addEventListener('submit', async (e) => {
		e.preventDefault()
		let res = await fetch('/login', { method: 'POST', body: new FormData(form) })
		if (res.ok) return page.chat()
		status.textContent = res.status === 401 ? 'wrong password' : `login failed (${res.status})`
		input.select()
	})
	document.body.replaceChildren(form)
	input.focus()
}

// Straight to the conversation if the cookie is good, else the form.
async function init(): Promise<void> {
	let res = await fetch('/login')
	if (res.status === 401) page.loginForm()
	else page.chat()
}

export const page = { state: createState(), store, onInput, draw, formNode, syncForm, pick, sendForm, onEvent, setNotice, onState, fitInput, onKey, chat, loginForm, init }

// Runs in the browser only; importing it elsewhere does nothing.
if (typeof document !== 'undefined') void page.init()
