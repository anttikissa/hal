import { createMemo, createSignal, onSettled, Show } from 'solid-js'
import { render } from '@solidjs/web'
import type { SharedState } from '../common/ipc.ts'
import type { ClientSessionSnapshot } from '../common/snapshots.ts'
import { webMessages, type WebServerMessage } from '../common/web.ts'
import { AuthGate } from './components/AuthGate.tsx'
import { PromptComposer } from './components/PromptComposer.tsx'
import { SessionTabs } from './components/SessionTabs.tsx'
import { Transcript } from './components/Transcript.tsx'
import { webTranscript } from './utils/transcript.ts'

const tokenStorageKey = 'hal-web-auth'

function initialToken(): string {
	const url = new URL(location.href)
	const token = url.searchParams.get('auth')
	if (token) {
		localStorage.setItem(tokenStorageKey, token)
		url.searchParams.delete('auth')
		history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
		return token
	}
	return localStorage.getItem(tokenStorageKey) ?? ''
}

type AuthenticatedAppProps = {
	onUnauthorized: () => void
	token: string
}

function AuthenticatedApp(props: AuthenticatedAppProps) {
	const [selected, setSelected] = createSignal('')
	const [sharedState, setSharedState] = createSignal<SharedState>({ sessions: [], working: {}, updatedAt: '' })
	const [snapshot, setSnapshot] = createSignal<ClientSessionSnapshot | null>(null)
	const transcript = createMemo(() => webTranscript.items(snapshot()))
	let subscribed = ''
	let socket: WebSocket | undefined
	let unauthorized = false

	async function request(path: string, init?: RequestInit): Promise<Response> {
		const headers = new Headers(init?.headers)
		headers.set('authorization', `Bearer ${props.token}`)
		const response = await fetch(path, { ...init, headers })
		if (response.status === 401) {
			unauthorized = true
			props.onUnauthorized()
		}
		return response
	}

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
		const response = await request(`/api/session?id=${encodeURIComponent(sessionId)}`)
		if (!response.ok) return
		if (socket?.readyState === WebSocket.OPEN && subscribed === sessionId) return
		const next = await response.json() as ClientSessionSnapshot
		if (next.session.id !== sessionId) return
		setSnapshot(next)
	}

	async function refreshTabs(): Promise<void> {
		const response = await request('/api/state')
		if (!response.ok) return
		const state = await response.json() as SharedState
		await refresh(applyState(state))
	}

	async function submitPrompt(text: string): Promise<boolean> {
		const sessionId = selected()
		if (!sessionId) return false
		const response = await request('/api/prompt', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sessionId, text }),
		})
		if (!response.ok) return false
		if (socket?.readyState !== WebSocket.OPEN) void refresh(sessionId)
		return true
	}

	onSettled(() => {
		const connection = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`)
		socket = connection
		connection.onopen = () => connection.send(JSON.stringify({ type: 'authenticate', token: props.token }))
		connection.onmessage = (event) => {
			let message: WebServerMessage
			try { message = JSON.parse(event.data) as WebServerMessage } catch { return }
			if (message.type === 'unauthorized') {
				unauthorized = true
				props.onUnauthorized()
				connection.close()
				return
			}
			if (message.type === 'authenticated') {
				void refreshTabs()
				return
			}
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
		connection.onclose = (event) => {
			if (event.code === 4001) {
				unauthorized = true
				props.onUnauthorized()
				return
			}
			if (!unauthorized) setTimeout(() => location.reload(), 1_000)
		}
		return () => connection.close()
	})

	return <>
		<SessionTabs sessions={sharedState().sessions} selected={selected()} onSelect={selectSession} />
		<Transcript items={transcript()} />
		<PromptComposer onSubmit={submitPrompt} />
	</>
}

function App(props: { token: string }) {
	const [token, setToken] = createSignal(props.token)
	function connect(nextToken: string): void {
		localStorage.setItem(tokenStorageKey, nextToken)
		setToken(nextToken)
	}
	function unauthorized(): void {
		localStorage.removeItem(tokenStorageKey)
		setToken('')
	}
	return <Show when={token()} fallback={<AuthGate onConnect={connect} />}>
		<AuthenticatedApp token={token()} onUnauthorized={unauthorized} />
	</Show>
}

const root = document.querySelector('#app')
if (!root) throw new Error('Missing app root')
render(() => <App token={initialToken()} />, root)
