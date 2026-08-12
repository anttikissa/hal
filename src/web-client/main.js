const tabs = document.querySelector('#tabs')
const messages = document.querySelector('#messages')
const form = document.querySelector('#form')
const prompt = document.querySelector('#prompt')
let selected = ''

function add(type, text) {
	const article = document.createElement('article')
	article.className = type
	const label = document.createElement('label')
	label.textContent = type
	const body = document.createElement('div')
	body.textContent = text
	article.append(label, body)
	messages.append(article)
}

async function refresh() {
	if (!selected) return
	const response = await fetch(`/api/session?id=${encodeURIComponent(selected)}`)
	if (!response.ok) return
	const data = await response.json()
	messages.replaceChildren()
	for (const entry of [...data.history, ...data.live]) add(entry.type, entry.text)
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
