const tabs = document.querySelector('#tabs')
import { transcriptTitles } from '../common/transcript-titles.ts'
const messages = document.querySelector('#messages')
const form = document.querySelector('#form')
const prompt = document.querySelector('#prompt')
let selected = ''

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

function valueText(value) {
	if (typeof value === 'string') return value
	if (value === undefined) return ''
	return JSON.stringify(value, null, 2)
}

function toolText(item) {
	if (typeof item.input?.command === 'string') return item.input.command
	if (typeof item.input?.code === 'string') return item.input.code
	if (item.input !== undefined) return valueText(item.input)
	return valueText(item.output)
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
	if (entry.type === 'tool_call' || entry.type === 'tool_result') return toolText(entry)
	if (entry.type === 'assistant' || entry.type === 'info' || entry.type === 'log' || entry.type === 'warning' || entry.type === 'error') {
		return typeof entry.text === 'string' ? entry.text : ''
	}
	return ''
}

function addIfText(item, text) {
	if (text) add(item, text)
}

async function refresh() {
	if (!selected) return
	const response = await fetch(`/api/session?id=${encodeURIComponent(selected)}`)
	if (!response.ok) return
	const data = await response.json()
	messages.replaceChildren()
	for (const entry of data.history) addIfText(entry, historyText(entry))
	for (const block of data.live) addIfText(block, block.type === 'tool' ? toolText(block) : block.text)
	messages.scrollTop = messages.scrollHeight
}

async function refreshTabs() {
	const response = await fetch('/api/state')
	if (!response.ok) return
	const data = await response.json()
	const sessions = data.sessions ?? []
	if (!selected && sessions[0]) selected = sessions[0].id
	tabs.replaceChildren()
	for (const session of sessions) {
		const button = document.createElement('button')
		button.textContent = `${session.tab ?? ''} ${session.name || session.id}`
		button.className = session.id === selected ? 'selected' : ''
		button.onclick = () => { selected = session.id; void refreshTabs(); void refresh() }
		tabs.append(button)
	}
}

form.onsubmit = async (event) => {
	event.preventDefault()
	const text = prompt.value.trim()
	if (!text || !selected) return
	prompt.value = ''
	await fetch('/api/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: selected, text }) })
	void refresh()
}

const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`)
socket.onmessage = () => { void refresh(); void refreshTabs() }
socket.onclose = () => setTimeout(() => location.reload(), 1000)
void refreshTabs().then(refresh)
