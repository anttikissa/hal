import { createMemo, createSignal, onSettled, Show } from 'solid-js'
import { render } from '@solidjs/web'
import type { SharedState } from '../common/ipc.ts'
import type { Command } from '../common/protocol.ts'
import type { ClientSessionSnapshot } from '../common/snapshots.ts'
import { webProtocol, type WebServerMessage } from '../common/web.ts'
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
	const snapshots = new Map<string, ClientSessionSnapshot>()
	let socket: WebSocket | undefined
	let unauthorized = false

	function selectSession(sessionId: string): void {
		if (!sessionId) return
		setSelected(sessionId)
		setSnapshot(snapshots.get(sessionId) ?? null)
	}

	function applyState(state: SharedState): void {
		let sessionId = selected()
		if (!state.sessions.some((session) => session.id === sessionId)) sessionId = state.sessions[0]?.id ?? ''
		setSharedState(state)
		if (sessionId !== selected()) selectSession(sessionId)
	}

	function sendCommand(command: Command): boolean {
		if (socket?.readyState !== WebSocket.OPEN) return false
		socket.send(webProtocol.encode({ type: 'command', command }))
		return true
	}

	function submitPrompt(text: string): Promise<boolean> {
		const sessionId = selected()
		if (!sessionId) return Promise.resolve(false)
		return Promise.resolve(sendCommand({ type: 'prompt', sessionId, text, source: 'web' }))
	}
	// Tab commands arrive loosely typed from SessionTabs; the server's
	// parseCommand is the real validator, so the cast is safe.
	function onTabCommand(command: Record<string, unknown>): void {
		sendCommand(command as unknown as Command)
	}


	onSettled(() => {
		const connection = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`)
		socket = connection
		connection.onopen = () => connection.send(webProtocol.encode({ type: 'authenticate', token: props.token }))
		connection.onmessage = (event) => {
			const message = webProtocol.decode(String(event.data)) as WebServerMessage | null
			if (!message || typeof message !== 'object' || !('type' in message)) return
			if (message.type === 'error') {
				unauthorized = true
				props.onUnauthorized()
				connection.close()
				return
			}
			if (message.type === 'authenticated') {
				for (const item of message.bootstrap.snapshots) snapshots.set(item.session.id, item)
				applyState(message.bootstrap.state)
				if (!selected()) selectSession(message.bootstrap.state.sessions[0]?.id ?? '')
				return
			}
			if (message.type === 'state') {
				applyState(message.state)
				return
			}
			if (message.type === 'snapshot') {
				snapshots.set(message.snapshot.session.id, message.snapshot)
				if (message.snapshot.session.id === selected()) setSnapshot(message.snapshot)
				return
			}
			if (message.event?.sessionId !== selected()) return
			const current = snapshot()
			const next = webProtocol.applySessionMessage(current, message)
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
		<SessionTabs
			sessions={sharedState().sessions}
			selected={selected()}
			working={sharedState().working}
			onSelect={selectSession}
			onCommand={onTabCommand}
		/>
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
