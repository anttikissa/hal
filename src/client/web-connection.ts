import type { SharedState } from '../common/ipc.ts'
import type { Command } from '../common/protocol.ts'
import type { ClientBootstrap, ClientSessionSnapshot } from '../common/snapshots.ts'
import type { WebServerMessage } from '../common/web.ts'
import { webProtocol } from '../common/web.ts'
import { clientBackend } from './backend.ts'
import { clientTransport } from './transport.ts'

type ParsedRemoteUrl = {
	webSocketUrl: string
	baseUrl: string
	token: string
}

const config = { retryMultiplier: 1.6, maxRetryDelayMs: 30_000 }
const state = {
	socket: null as WebSocket | null,
	shared: { sessions: [], working: {}, updatedAt: '' } as SharedState,
	metas: new Map<string, ClientBootstrap['metas'][number]>(),
	snapshots: new Map<string, ClientSessionSnapshot>(),
	events: [] as any[],
	wakeEvent: null as (() => void) | null,
	stateListener: null as ((shared: SharedState) => void) | null,
	reconnecting: false,
}

function parseUrl(input: string): ParsedRemoteUrl {
	if (!/^https?:\/\//.test(input)) throw new Error('Remote URL must start with http:// or https://')
	const url = new URL(input)
	const token = url.searchParams.get('auth') ?? ''
	if (!token) throw new Error('Remote URL must contain ?auth=<token>')
	url.search = ''
	url.hash = ''
	url.pathname = url.pathname.replace(/\/$/, '')
	const baseUrl = url.toString().replace(/\/$/, '')
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	url.pathname = '/ws'
	return { webSocketUrl: url.toString(), baseUrl, token }
}

function applySnapshot(snapshot: ClientSessionSnapshot): void {
	state.snapshots.set(snapshot.session.id, snapshot)
	state.metas.set(snapshot.meta.id, snapshot.meta)
}

function applyBootstrap(bootstrap: ClientBootstrap): void {
	state.shared = bootstrap.state
	state.metas.clear()
	state.snapshots.clear()
	for (const meta of bootstrap.metas) state.metas.set(meta.id, meta)
	for (const snapshot of bootstrap.snapshots) webConnection.applySnapshot(snapshot)
}

function queueEvent(event: any): void {
	state.events.push(event)
	state.wakeEvent?.()
	state.wakeEvent = null
}


function nextRetryDelay(delay: number): number {
	if (delay === 0) return 1_000
	return Math.min(Math.round(delay * webConnection.config.retryMultiplier), webConnection.config.maxRetryDelayMs)
}

function applyReconnectBootstrap(bootstrap: ClientBootstrap): void {
	state.events = []
	webConnection.applyBootstrap(bootstrap)
	state.stateListener?.(bootstrap.state)
	for (const snapshot of bootstrap.snapshots) webConnection.queueEvent({ type: 'history-rebased', sessionId: snapshot.session.id })
}

function applyMessage(message: WebServerMessage): void {
	if (message.type === 'state') {
		state.shared = message.state
		state.stateListener?.(message.state)
		return
	}
	if (message.type === 'snapshot') {
		webConnection.applySnapshot(message.snapshot)
		return
	}
	if (message.type === 'event') webConnection.queueEvent(message.event)
}

function install(): void {
	clientBackend.install({
		sessions: {
			loadAllSessionMetas: () => [...state.metas.values()],
			loadSessionMeta: (sessionId) => state.metas.get(sessionId) ?? null,
			loadHistoryLog: (sessionId) => state.snapshots.get(sessionId)?.history ?? [],
			loadAllHistoryWithOrigin: (sessionId) => {
				const snapshot = state.snapshots.get(sessionId)
				return {
					entries: snapshot?.history ?? [],
					parentCount: snapshot?.parentCount ?? 0,
					parentId: snapshot?.parentId,
				}
			},
			loadLive: (sessionId) => ({ blocks: state.snapshots.get(sessionId)?.live ?? [] }),
		},
	})
	clientTransport.install({
		appendCommand: (command) => webConnection.sendCommand(command),
		notifyDraftSaved: () => {},
		readState: () => state.shared,
		watchState: (callback) => { state.stateListener = callback },
		tailEvents: (signal) => webConnection.tailEvents(signal),
	})
}

function sendCommand(command: Command): void {
	if (state.socket?.readyState !== WebSocket.OPEN) throw new Error('Remote HAL connection is closed')
	state.socket.send(webProtocol.encode({ type: 'command', command }))
}

async function* tailEvents(signal?: AbortSignal): AsyncGenerator<any> {
	while (!signal?.aborted) {
		const event = state.events.shift()
		if (event !== undefined) {
			yield event
			continue
		}
		await new Promise<void>((resolve) => {
			state.wakeEvent = resolve
			signal?.addEventListener('abort', () => resolve(), { once: true })
		})
	}
}

function openSocket(parsed: ParsedRemoteUrl, signal: AbortSignal, reconnect: boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		let authenticated = false
		const socket = new WebSocket(parsed.webSocketUrl)
		state.socket = socket
		socket.onopen = () => socket.send(webProtocol.encode({ type: 'authenticate', token: parsed.token }))
		socket.onmessage = (event) => {
			const message = webProtocol.decode(String(event.data)) as WebServerMessage | null
			if (!message || typeof message !== 'object' || !('type' in message)) return
			if (message.type === 'error') {
				reject(new Error(message.message))
				return
			}
			if (message.type === 'authenticated') {
				// A reconnect replaces stale cached sessions, so the whole bootstrap wins
				// over whatever this client believed before the host went away.
				if (reconnect) webConnection.applyReconnectBootstrap(message.bootstrap)
				else webConnection.applyBootstrap(message.bootstrap)
				webConnection.install()
				authenticated = true
				resolve()
				return
			}
			webConnection.applyMessage(message)
		}
		socket.onerror = () => {
			if (!authenticated) reject(new Error(`Could not connect to ${parsed.baseUrl}`))
		}
		socket.onclose = () => {
			reject(new Error('Connection closed'))
			state.wakeEvent?.()
			state.wakeEvent = null
			if (authenticated) void webConnection.reconnect(parsed, signal)
		}
		signal.addEventListener('abort', () => socket.close(), { once: true })
	})
}

// The host restarts often (Ctrl-R, upgrades), so a closed socket is normal rather
// than fatal. Retry immediately, then back off until the host answers again.
async function reconnect(parsed: ParsedRemoteUrl, signal: AbortSignal): Promise<void> {
	if (state.reconnecting) return
	state.reconnecting = true
	let delay = 0
	try {
		while (!signal.aborted) {
			if (delay > 0) await Bun.sleep(delay)
			if (signal.aborted) return
			try {
				await webConnection.openSocket(parsed, signal, true)
				return
			} catch {
				delay = webConnection.nextRetryDelay(delay)
			}
		}
	} finally {
		state.reconnecting = false
	}
}

function connect(input: string, signal: AbortSignal): Promise<void> {
	return webConnection.openSocket(webConnection.parseUrl(input), signal, false)
}

function reset(): void {
	state.socket?.close()
	state.socket = null
	state.shared = { sessions: [], working: {}, updatedAt: '' }
	state.metas.clear()
	state.snapshots.clear()
	state.events = []
	state.wakeEvent = null
	state.stateListener = null
	state.reconnecting = false
}

export const webConnection = {
	state,
	config,
	parseUrl,
	applySnapshot,
	applyBootstrap,
	applyReconnectBootstrap,
	nextRetryDelay,
	queueEvent,
	applyMessage,
	install,
	sendCommand,
	tailEvents,
	openSocket,
	reconnect,
	connect,
	reset,
}
