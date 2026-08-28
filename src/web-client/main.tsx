import { createEffect, createMemo, createSignal, onSettled, Show } from 'solid-js'
import { render } from '@solidjs/web'
import type { AnswerValue } from '../common/history.ts'
import { historyProjection } from '../common/history-projection.ts'
import type { SharedState } from '../common/ipc.ts'
import type { Command } from '../common/protocol.ts'
import type { ClientSessionSnapshot } from '../common/snapshots.ts'
import { webProtocol, type WebServerMessage } from '../common/web.ts'
import { historyIds } from '../common/history-ids.ts'
import { liveEventBlocks } from '../common/live-event-blocks.ts'
import { AuthGate } from './components/AuthGate.tsx'
import { PromptComposer } from './components/PromptComposer.tsx'
import { SessionTabs } from './components/SessionTabs.tsx'
import { Transcript } from './components/Transcript.tsx'
import { webStatus } from './utils/status.ts'
import { webTranscript } from './utils/transcript.ts'
import { sessionSelection } from './utils/session-selection.ts'
import { webViewport } from './utils/viewport.ts'
import { router } from './router.ts'

const tokenStorageKey = 'hal-web-auth'

function initialToken(): string {
	const token = router.takeSearchParam('auth')
	if (token) {
		localStorage.setItem(tokenStorageKey, token)
		return token
	}
	return localStorage.getItem(tokenStorageKey) ?? ''
}

type AuthenticatedAppProps = {
	onUnauthorized: () => void
	token: string
}

function AuthenticatedApp(props: AuthenticatedAppProps) {
	// The URL owns the selected session, so a tab is shareable as
	// example.test/05-wan and Back/Forward move between tabs.
	const selected = router.sessionId
	const [sharedState, setSharedState] = createSignal<SharedState>({ sessions: [], working: {}, updatedAt: '' })
	const [snapshot, setSnapshot] = createSignal<ClientSessionSnapshot | null>(null)
	const transcript = createMemo(() => {
		const current = snapshot()
		if (!current || current.session.id !== selected()) return []
		return webTranscript.items(current)
	})
	const activeQuestion = createMemo(() => {
		const current = snapshot()
		if (!current || current.session.id !== selected()) return undefined
		return historyProjection.activeQuestion(current.history, current.parentCount)
	})
	// Shared state keeps cwd/model current; the selected snapshot supplies the
	// context usage that the host persists after each completed turn.
	const session = createMemo(() => sharedState().sessions.find((item) => item.id === selected()))
	const status = createMemo(() => webStatus.text(session(), snapshot()?.meta))
	const snapshots = new Map<string, ClientSessionSnapshot>()
	// Session ids from the previous broadcast, so an "open tab" command can
	// spot the session that appears for the first time and select it.
	let previousIds = new Set<string>()
	let socket: WebSocket | undefined
	let unauthorized = false

	// `replace` is for selections the user did not ask for (the initial landing
	// tab, or a tab closing under us): those should not add history entries.
	function selectSession(sessionId: string, replace = false): void {
		if (!sessionId) return
		router.navigate(sessionId, { replace })
	}

	// The cached snapshot follows the route, so Back/Forward and tab clicks are
	// the same code path. Live events and fresh snapshots update it separately.
	createEffect(selected, (sessionId) => { setSnapshot(snapshots.get(sessionId) ?? null) })

	function applyState(state: SharedState): void {
		const pending = sessionSelection.isOpenRequestPending()
		const sessionId = sessionSelection.nextSelection(state, selected(), previousIds, pending)
		// Landing on the tab our own "+ New tab" click created is a real
		// navigation, so it gets a history entry and Back returns to the tab we
		// came from. Everything else here is the app reconciling, not the user.
		const opened = pending && !previousIds.has(sessionId)
		previousIds = new Set(state.sessions.map((session) => session.id))
		setSharedState(state)
		if (sessionId !== selected()) selectSession(sessionId, !opened)
	}

	function sendCommand(command: Command): boolean {
		if (socket?.readyState !== WebSocket.OPEN) return false
		socket.send(webProtocol.encode({ type: 'command', command }))
		return true
	}

	// `queue` is the same flag the terminal's /queue uses: the host parks the
	// prompt and runs it when the current turn finishes instead of interrupting.
	function submitPrompt(text: string, queue: boolean): Promise<boolean> {
		const sessionId = selected()
		const current = snapshot()
		if (!sessionId || !current) return Promise.resolve(false)
		const id = historyIds.make()
		if (!sendCommand({ type: 'prompt', id, sessionId, text, source: 'web', queue })) return Promise.resolve(false)
		if (!queue && !text.trimStart().startsWith('/')) {
			const next = { ...current, live: liveEventBlocks.reduce(current.live, { type: 'prompt', id, text, createdAt: new Date().toISOString() }).blocks }
			snapshots.set(sessionId, next)
			setSnapshot(next)
		}
		return Promise.resolve(true)
	}

	function submitAnswer(questionId: string, value: AnswerValue): Promise<boolean> {
		const sessionId = snapshot()?.session.id
		if (!sessionId || sessionId !== selected()) return Promise.resolve(false)
		return Promise.resolve(sendCommand({ type: 'answer', sessionId, questionId, value }))
	}
	// Tab commands arrive loosely typed from SessionTabs; the server's
	// parseCommand is the real validator, so the cast is safe.
	function onTabCommand(command: Record<string, unknown>): void {
		if (command.type === 'open') sessionSelection.markOpenRequest()
		sendCommand(command as unknown as Command)
	}


	async function attachImage(file: File): Promise<string> {
		const form = new FormData()
		form.append('file', file, file.name)
		const response = await fetch(`/upload?auth=${encodeURIComponent(props.token)}`, { method: 'POST', body: form })
		const body = await response.json().catch(() => null) as { path?: unknown; error?: unknown } | null
		if (!response.ok || !body || typeof body.path !== 'string') {
			throw new Error(body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
		}
		return body.path
	}

	// Adopt the URL the page was opened with and follow Back/Forward from here on.
	onSettled(() => router.start())

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
				// applyState keeps a valid session from the URL and otherwise
				// falls back to the first tab, correcting the address bar.
				applyState(message.bootstrap.state)
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
			status={status()}
			working={sharedState().working}
			onSelect={selectSession}
			onCommand={onTabCommand}
		/>
		<Transcript items={transcript()} onAnswer={submitAnswer} />
		<PromptComposer location={webStatus.location(session())} disabled={!!activeQuestion()} working={!!sharedState().working[selected()]} onSubmit={submitPrompt} onAttach={attachImage} />
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
webViewport.sync(window.visualViewport ?? undefined, document.documentElement.style)
render(() => <App token={initialToken()} />, root)
