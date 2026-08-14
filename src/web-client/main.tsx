import { createMemo, createSignal, onSettled } from 'solid-js'
import { render } from '@solidjs/web'
import type { SharedState } from '../common/ipc.ts'
import type { ClientSessionSnapshot } from '../common/snapshots.ts'
import { webMessages, type WebServerMessage } from '../common/web.ts'
import { PromptComposer } from './components/PromptComposer.tsx'
import { SessionTabs } from './components/SessionTabs.tsx'
import { Transcript } from './components/Transcript.tsx'
import { webTranscript } from './utils/transcript.ts'

function App() {
	const [selected, setSelected] = createSignal('')
	const [sharedState, setSharedState] = createSignal<SharedState>({ sessions: [], working: {}, updatedAt: '' })
	const [snapshot, setSnapshot] = createSignal<ClientSessionSnapshot | null>(null)
	const transcript = createMemo(() => webTranscript.items(snapshot()))
	let subscribed = ''
	let socket: WebSocket | undefined

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

	async function submitPrompt(text: string): Promise<boolean> {
		const sessionId = selected()
		if (!sessionId) return false
		await fetch('/api/prompt', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sessionId, text }),
		})
		if (socket?.readyState !== WebSocket.OPEN) void refresh(sessionId)
		return true
	}

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
		<Transcript items={transcript()} />
		<PromptComposer onSubmit={submitPrompt} />
	</>
}

const root = document.querySelector('#app')
if (!root) throw new Error('Missing app root')
render(() => <App />, root)
