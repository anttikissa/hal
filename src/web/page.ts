/// <reference lib="dom" />
// The browser client's page: a password form until the cookie is set,
// then one session's transcript above a textarea. Enter submits
// (Shift+Enter is a newline), Escape cancels a running turn. Plain DOM;
// web.ts bundles this file into index.html at request time.

import type { Event } from '../common/protocol.ts'
import { transcript, type Item } from '../common/transcript.ts'
import { connection, type LinkState } from '../common/connection.ts'
import { link } from './link.ts'
import { view, type ViewState } from './view.ts'

type PageState = {
	view: ViewState
	// Transcript items on screen and their nodes, in order.
	drawn: { item: Item; node: HTMLElement | null }[]
	log: HTMLElement | null
	// The line marking where replayed history ends.
	resumed: HTMLElement | null
	notice: HTMLElement | null
	input: HTMLTextAreaElement | null
}

function createState(): PageState {
	return { view: {}, drawn: [], log: null, resumed: null, notice: null, input: null }
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
	let first = 0
	while (first < items.length && first < st.drawn.length && items[first] === st.drawn[first]!.item) first++
	for (let d of st.drawn.splice(first)) d.node?.remove()
	for (let item of items.slice(first)) {
		let shown = view.show(item)
		let node = shown ? el('div', { className: shown.kind, textContent: shown.text }) : null
		if (node) log.append(node)
		st.drawn.push({ item, node })
	}
	let resumed = st.view.resumed
	if (resumed) {
		st.resumed ??= el('div', { className: 'log' })
		st.resumed.textContent = transcript.resumedLabel(resumed)
		let next = st.drawn.slice(resumed.at).find((d) => d.node)?.node
		if (next) log.insertBefore(st.resumed, next)
		else log.append(st.resumed)
	} else st.resumed?.remove()
	st.notice!.textContent = st.view.notice ?? ''
	let status = view.status(st.view)
	st.input!.placeholder = status ? `${status}; Escape pauses a running turn` : 'Message Hal (Enter sends, Shift+Enter for a newline)'
	if (atBottom) log.scrollTop = log.scrollHeight
}

function onEvent(event: Event): void {
	page.state.view = view.onEvent(page.state.view, event)
	page.draw()
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
	if (e.key === 'Escape') {
		let command = view.pause(st.view)
		if (command) connection.send(command)
		return
	}
	if (e.key !== 'Enter' || e.shiftKey || e.target !== st.input) return
	e.preventDefault()
	let { command, notice, keep } = view.submit(st.view, st.input!.value)
	// Until drafts and pending prompts (task rw), typed text waits here.
	if (command && !connection.connected()) notice = 'not connected; try again in a moment'
	else {
		if (command) connection.send(command)
		if (!keep) st.input!.value = ''
	}
	page.setNotice(notice)
	page.fitInput()
}

function chat(): void {
	let st = page.state
	document.body.replaceChildren()
	st.log = el('main', { role: 'log' } as Partial<HTMLElement>)
	st.notice = el('div', { id: 'notice', className: 'log' })
	st.input = el('textarea', { rows: 1, autofocus: true, ariaLabel: 'Message', className: 'input' })
	st.input.addEventListener('input', () => page.fitInput())
	let footer = el('footer')
	footer.append(st.notice, st.input)
	document.body.append(st.log, footer)
	document.addEventListener('keydown', (e) => page.onKey(e))
	st.input.focus()
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

export const page = { state: createState(), draw, onEvent, setNotice, onState, fitInput, onKey, chat, loginForm, init }

// Runs in the browser only; importing it elsewhere does nothing.
if (typeof document !== 'undefined') void page.init()
