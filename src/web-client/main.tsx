import { createEffect, createMemo, createSignal, For, onSettled } from 'solid-js'
import { render } from '@solidjs/web'
import type { HistoryEntry } from '../common/history.ts'
import type { SharedSessionInfo, SharedState } from '../common/ipc.ts'
import type { LiveBlock } from '../common/live-event-blocks.ts'
import type { ClientSessionSnapshot } from '../common/snapshots.ts'
import { transcriptTitles } from '../common/transcript-titles.ts'
import { webMessages, type WebServerMessage } from '../common/web.ts'
import { webPresentation } from './presentation.ts'

type TranscriptItem = HistoryEntry | LiveBlock
type RenderedItem = { item: TranscriptItem; text: string }

type SessionTabsProps = {
	sessions: SharedSessionInfo[]
	selected: string
	onSelect: (sessionId: string) => void
}

type MessageProps = {
	item: TranscriptItem
	text: string
}

function historyText(item: TranscriptItem): string {
	if (item.type === 'user') {
		if (!('parts' in item)) return item.text
		const parts: string[] = []
		for (const part of item.parts) {
			if (part.type === 'text') parts.push(part.displayText ?? part.text)
		}
		return parts.join('\n')
	}
	if (item.type === 'thinking') return item.text ?? ''
	if (item.type === 'tool' || item.type === 'tool_call' || item.type === 'tool_result') return webPresentation.toolText(item)
	if (item.type === 'assistant' || item.type === 'info' || item.type === 'log' || item.type === 'warning' || item.type === 'error') {
		return typeof item.text === 'string' ? item.text : ''
	}
	return ''
}

function transcriptItems(snapshot: ClientSessionSnapshot | null): RenderedItem[] {
	if (!snapshot) return []
	const items: RenderedItem[] = []
	for (const item of webPresentation.historyItems(snapshot.history)) {
		const text = historyText(item)
		if (text) items.push({ item, text })
	}
	for (const item of snapshot.live) {
		const text = item.type === 'tool' ? webPresentation.toolText(item) : item.text
		if (text) items.push({ item, text })
	}
	return items
}

function SessionTabs(props: SessionTabsProps) {
	return <header id="tabs">
		<For each={props.sessions}>
			{(session) => <button class={{ selected: session.id === props.selected }} onClick={() => props.onSelect(session.id)}>
				{session.tab ?? ''} {session.name || session.id}
			</button>}
		</For>
	</header>
}

function Message(props: MessageProps) {
	return <article class={props.item.type}>
		<label>{transcriptTitles.label(props.item)}</label>
		<div>{props.text}</div>
	</article>
}

function App() {
	const [selected, setSelected] = createSignal('')
	const [sharedState, setSharedState] = createSignal<SharedState>({ sessions: [], working: {}, updatedAt: '' })
	const [snapshot, setSnapshot] = createSignal<ClientSessionSnapshot | null>(null)
	const transcript = createMemo(() => transcriptItems(snapshot()))
	let subscribed = ''
	let socket: WebSocket | undefined
	let messages: HTMLElement | undefined
	let prompt: HTMLInputElement | undefined

	function subscribe(sessionId: string): void {
		if (!sessionId || socket?.readyState !== WebSocket.OPEN || subscribed === sessionId) return
		subscribed = sessionId
		socket.send(JSON.stringify({ type: 'subscribe', sessionId }))
	}

	function selectSession(sessionId: string): void {
		if (selected() === sessionId && snapshot()?.session.id === sessionId) return
		setSelected(sessionId)
		setSnapshot(null)
		subscribe(sessionId)
	}

	function applyState(state: SharedState): string {
		let sessionId = selected()
		if (!state.sessions.some((session) => session.id === sessionId)) {
			sessionId = state.sessions[0]?.id ?? ''
			setSelected(sessionId)
			setSnapshot(null)
			subscribed = ''
		}
		setSharedState(state)
		subscribe(sessionId)
		return sessionId
	}

	async function refresh(sessionId: string): Promise<void> {
		if (!sessionId) return
		const response = await fetch(`/api/session?id=${encodeURIComponent(sessionId)}`)
		if (!response.ok) return
		if (socket?.readyState === WebSocket.OPEN && subscribed === sessionId) return
		const next = await response.json() as ClientSessionSnapshot
		if (next.session.id !== sessionId) return
		setSnapshot(next)
	}

	async function refreshTabs(): Promise<void> {
		const response = await fetch('/api/state')
		if (!response.ok) return
		const state = await response.json() as SharedState
		await refresh(applyState(state))
	}

	async function submitPrompt(event: SubmitEvent): Promise<void> {
		event.preventDefault()
		const text = prompt?.value.trim() ?? ''
		const sessionId = selected()
		if (!text || !sessionId || !prompt) return
		prompt.value = ''
		await fetch('/api/prompt', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sessionId, text }),
		})
		if (socket?.readyState !== WebSocket.OPEN) void refresh(sessionId)
	}

	createEffect(
		() => snapshot(),
		() => {
			if (messages) messages.scrollTop = messages.scrollHeight
		},
	)

	onSettled(() => {
		const connection = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`)
		socket = connection
		connection.onopen = () => {
			subscribed = ''
			subscribe(selected())
		}
		connection.onmessage = (event) => {
			let message: WebServerMessage
			try { message = JSON.parse(event.data) as WebServerMessage } catch { return }
			if (message.type === 'state') {
				applyState(message.state)
				return
			}
			if ((message.type === 'snapshot' && message.snapshot.session.id !== selected())
				|| (message.type === 'event' && message.event.sessionId !== selected())) return
			const current = snapshot()
			const next = webMessages.applySessionMessage(current, message)
			if (next !== current) setSnapshot(next)
		}
		connection.onclose = () => setTimeout(() => location.reload(), 1_000)
		void refreshTabs()
		return () => connection.close()
	})

	return <>
		<SessionTabs sessions={sharedState().sessions} selected={selected()} onSelect={selectSession} />
		<main id="messages" ref={(element) => { messages = element }}>
			<For each={transcript()}>{(item) => <Message item={item.item} text={item.text} />}</For>
		</main>
		<form id="form" onSubmit={submitPrompt}>
			<input id="prompt" ref={(element) => { prompt = element }} autocomplete="off" placeholder="Message" autofocus />
			<button>Send</button>
		</form>
	</>
}

const root = document.querySelector('#app')
if (!root) throw new Error('Missing app root')
render(() => <App />, root)
