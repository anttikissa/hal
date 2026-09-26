/// <reference lib="dom" />
// The browser client's page: a password form until the cookie is set,
// then one session's transcript above a textarea. Enter submits
// (Shift+Enter is a newline), Escape cancels a running turn. Plain DOM;
// web.ts bundles this file into index.html at request time.

import type { Event } from '../common/protocol.ts'
import type { Item } from '../common/transcript.ts'
import { link } from './link.ts'
import { view, type ViewState } from './view.ts'

type PageState = {
	view: ViewState
	// Transcript items on screen and their nodes, in order.
	drawn: { item: Item; node: HTMLElement | null }[]
	log: HTMLElement | null
	notice: HTMLElement | null
	input: HTMLTextAreaElement | null
}

function createState(): PageState {
	return { view: {}, drawn: [], log: null, notice: null, input: null }
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
	st.notice!.textContent = st.view.notice ?? ''
	st.input!.placeholder = st.view.transcript?.live ? 'running… Escape cancels' : 'Message Hal (Enter sends, Shift+Enter for a newline)'
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

// Opens the session on screen again after a reconnect, else the newest
// one, else a new one in the host's working directory.
async function opening(): Promise<unknown> {
	let id = page.state.view.transcript?.meta.id
	if (id) return { type: 'open', sessionId: id }
	let res = await fetch('/session')
	if (res.status === 401) location.reload()
	if (res.status === 200) return { type: 'open', sessionId: await res.text() }
	return { type: 'create', cwd: res.headers.get('hal-cwd') ?? '/' }
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
		let command = view.cancel(st.view)
		if (command) link.send(command)
		return
	}
	if (e.key !== 'Enter' || e.shiftKey || e.target !== st.input) return
	e.preventDefault()
	let { command, notice, keep } = view.submit(st.view, st.input!.value)
	if (command && !link.send(command)) notice = 'not connected; try again in a moment'
	else if (!keep) st.input!.value = ''
	page.setNotice(notice)
	page.fitInput()
}

function chat(): void {
	let st = page.state
	document.body.replaceChildren()
	st.log = el('main', { role: 'log' } as Partial<HTMLElement>)
	st.notice = el('div', { id: 'notice' })
	st.input = el('textarea', { rows: 1, autofocus: true, ariaLabel: 'Message' })
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
		opening: () => page.opening(),
		onEvent: (e) => page.onEvent(e),
		onConnected: (up) => page.setNotice(up ? undefined : 'disconnected; reconnecting…'),
	})
}

function loginForm(): void {
	let form = el('form')
	let input = el('input', { type: 'password', name: 'password', placeholder: 'Password', autofocus: true, ariaLabel: 'Password' })
	let status = el('div', { id: 'notice' })
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
	let res = await fetch('/session')
	if (res.status === 401) page.loginForm()
	else page.chat()
}

export const page = { state: createState(), draw, onEvent, setNotice, opening, fitInput, onKey, chat, loginForm, init }

// Runs in the browser only; importing it elsewhere does nothing.
if (typeof document !== 'undefined') void page.init()
