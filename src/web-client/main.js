import { transcriptTitles } from '../common/transcript-titles.ts'
import { webMessages } from '../common/web.ts'
import { webPresentation } from './presentation.ts'

const tabs = document.querySelector('#tabs')
const messages = document.querySelector('#messages')
const form = document.querySelector('#form')
const prompt = document.querySelector('#prompt')
let selected = ''
let subscribed = ''
let sharedState = { sessions: [] }
let snapshot = null

function add(item, text) {
	const article = document.createElement('article')
	article.className = item.type
	const label = document.createElement('label')
	label.textContent = transcriptTitles.label(item)
	const body = document.createElement('div')
	body.textContent = text
	article.append(label, body)
	messages.append(article)
}

function historyText(entry) {
	if (entry.type === 'user') {
		const parts = []
		for (const part of entry.parts) {
			if (part.type === 'text') parts.push(part.displayText ?? part.text)
		}
		return parts.join('\n')
	}
	if (entry.type === 'thinking') return entry.text ?? ''
	if (entry.type === 'tool' || entry.type === 'tool_call' || entry.type === 'tool_result') return webPresentation.toolText(entry)
	if (entry.type === 'assistant' || entry.type === 'info' || entry.type === 'log' || entry.type === 'warning' || entry.type === 'error') {
		return typeof entry.text === 'string' ? entry.text : ''
	}
	return ''
}

function addIfText(item, text) {
	if (text) add(item, text)
}

function renderSnapshot() {
	messages.replaceChildren()
	if (!snapshot) return
	for (const entry of webPresentation.historyItems(snapshot.history)) addIfText(entry, historyText(entry))
	for (const block of snapshot.live) addIfText(block, block.type === 'tool' ? webPresentation.toolText(block) : block.text)
	messages.scrollTop = messages.scrollHeight
}

function subscribe() {
	if (!selected || socket.readyState !== WebSocket.OPEN || subscribed === selected) return
	subscribed = selected
	socket.send(JSON.stringify({ type: 'subscribe', sessionId: selected }))
}

function selectSession(sessionId) {
	if (selected === sessionId && snapshot?.session.id === sessionId) return
	selected = sessionId
	snapshot = null
	renderTabs()
	renderSnapshot()
	subscribe()
}

function renderTabs() {
	tabs.replaceChildren()
	for (const session of sharedState.sessions) {
		const button = document.createElement('button')
		button.textContent = `${session.tab ?? ''} ${session.name || session.id}`
		button.className = session.id === selected ? 'selected' : ''
		button.onclick = () => selectSession(session.id)
		tabs.append(button)
	}
}

function applyState(state) {
	sharedState = state
	const selectedExists = state.sessions.some((session) => session.id === selected)
	if (!selectedExists) {
		selected = state.sessions[0]?.id ?? ''
		snapshot = null
		subscribed = ''
	}
	renderTabs()
	subscribe()
}

async function refresh() {
	if (!selected) return
	const response = await fetch(`/api/session?id=${encodeURIComponent(selected)}`)
	if (!response.ok) return
	// Once subscribed, the WebSocket snapshot is the ordered baseline. A slower
	// HTTP fallback must not overwrite events that arrived after that baseline.
	if (socket.readyState === WebSocket.OPEN && subscribed === selected) return
	const next = await response.json()
	if (next.session.id !== selected) return
	snapshot = next
	renderSnapshot()
}

async function refreshTabs() {
	const response = await fetch('/api/state')
	if (!response.ok) return
	applyState(await response.json())
}

form.onsubmit = async (event) => {
	event.preventDefault()
	const text = prompt.value.trim()
	if (!text || !selected) return
	prompt.value = ''
	await fetch('/api/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: selected, text }) })
	if (socket.readyState !== WebSocket.OPEN) void refresh()
}

const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`)
socket.onopen = () => {
	subscribed = ''
	subscribe()
}
socket.onmessage = (event) => {
	let message
	try { message = JSON.parse(event.data) } catch { return }
	if (message.type === 'state' && message.state) {
		applyState(message.state)
		return
	}
	if ((message.type === 'snapshot' && message.snapshot?.session.id !== selected)
		|| (message.type === 'event' && message.event?.sessionId !== selected)) return
	const next = webMessages.applySessionMessage(snapshot, message)
	if (next === snapshot) return
	snapshot = next
	renderSnapshot()
}
socket.onclose = () => setTimeout(() => location.reload(), 1000)
void refreshTabs().then(refresh)
