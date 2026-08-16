// Local browser client. This module is imported only for `hal --web`; browser code
// is bundled lazily on the first request so it never affects normal startup.

import type { LiveEvent } from '../common/live-event-blocks.ts'
import type { ClientSessionSnapshot } from '../common/snapshots.ts'
import type { WebClientMessage, WebServerMessage } from '../common/web.ts'
import type { HistoryEntry } from '../common/history.ts'
import { blob } from './session/blob.ts'
import { ipc } from './file-ipc.ts'
import { runtime } from './runtime.ts'
import { sessions } from './sessions.ts'
import { webTokens, type WebToken } from './web-tokens.ts'

type SocketData = {
	id: string
	ip: string
	sessionId?: string
	token?: string
}

const state: {
	port: number
	server: Bun.Server<SocketData> | null
} = {
	port: 0,
	server: null,
}

function pageHtml(): Promise<string> {
	return Bun.file(`${import.meta.dir}/../web-client/index.html`).text()
}

function styleCss(): Promise<string> {
	return Bun.file(`${import.meta.dir}/../web-client/styles.css`).text()
}

function openSession(sessionId: string): boolean {
	return ipc.readState().sessions.some((session) => session.id === sessionId)
}

function hydrateHistory(sessionId: string, history: HistoryEntry[]): HistoryEntry[] {
	return history.map((entry) => {
		if (entry.type !== 'tool_result' || entry.output !== undefined || !entry.blobId) return entry
		const output = blob.readBlobFromChain(sessionId, entry.blobId)?.result?.content
		return typeof output === 'string' ? { ...entry, output } : entry
	})
}

function sessionSnapshot(sessionId: string): ClientSessionSnapshot | null {
	const session = ipc.readState().sessions.find((item) => item.id === sessionId)
	if (!session) return null
	return {
		session,
		history: web.hydrateHistory(sessionId, sessions.loadAllHistory(sessionId)),
		live: sessions.loadLive(sessionId).blocks,
	}
}

function snapshotResponse(sessionId: string): Response {
	const snapshot = web.sessionSnapshot(sessionId)
	if (!snapshot) return new Response('Unknown open session', { status: 404 })
	return Response.json(snapshot)
}

function parseClientMessage(text: string): WebClientMessage | null {
	let value: unknown
	try { value = JSON.parse(text) } catch { return null }
	if (!value || typeof value !== 'object') return null
	const message = value as Record<string, unknown>
	if (message.type === 'authenticate' && typeof message.token === 'string' && message.token) return { type: 'authenticate', token: message.token }
	if (message.type === 'subscribe' && typeof message.sessionId === 'string' && message.sessionId) return { type: 'subscribe', sessionId: message.sessionId }
	return null
}

function isLiveEvent(event: unknown): event is LiveEvent {
	if (!event || typeof event !== 'object') return false
	const value = event as Record<string, unknown>
	if (typeof value.sessionId !== 'string' || !value.sessionId) return false
	return value.type === 'prompt'
		|| value.type === 'stream-start'
		|| value.type === 'stream-delta'
		|| value.type === 'stream-end'
		|| value.type === 'tool-call'
		|| value.type === 'tool-result'
		|| value.type === 'tool-confirm-request'
		|| value.type === 'info'
		|| value.type === 'response'
}

function liveEventMessage(event: unknown): Extract<WebServerMessage, { type: 'event' }> | null {
	return isLiveEvent(event) ? { type: 'event', event } : null
}

function isSnapshotBoundary(event: unknown): boolean {
	if (!event || typeof event !== 'object') return false
	const type = (event as { type?: unknown }).type
	return type === 'stream-end' || type === 'history-rebased'
}

function encode(message: WebServerMessage): string {
	return JSON.stringify(message)
}

function sessionTopic(sessionId: string): string {
	return `session:${sessionId}`
}

async function bundleClient(): Promise<string> {
	const { transform } = await import('@dom-expressions/compiler')
	const result = await Bun.build({
		entrypoints: [`${import.meta.dir}/../web-client/main.tsx`],
		target: 'browser',
		minify: true,
		plugins: [{
			name: 'solid-oxc',
			setup(build) {
				build.onLoad({ filter: /\.tsx$/ }, async (args) => {
					const source = await Bun.file(args.path).text()
					return {
						contents: transform(source, { filename: args.path, moduleName: '@solidjs/web', generate: 'dom' }).code,
						// Oxc consumes JSX; Bun's TypeScript loader strips any remaining types.
						loader: 'ts',
					}
				})
			},
		}],
	})
	if (!result.success || !result.outputs[0]) throw new Error(result.logs.map(String).join('\n'))
	return result.outputs[0].text()
}

function nextPort(previousPort: number, tries: number, random = Math.random): number {
	return previousPort + Math.floor((1 + random() * 2) ** tries)
}

function announce(sessionId: string | undefined, port: number): void {
	if (!sessionId) return
	runtime.emitInfo(sessionId, `Web interface available at ${web.urlForToken(webTokens.ensureLocalToken(), port)}`)
}

function authorizationToken(request: Request): string | null {
	const value = request.headers.get('authorization')
	const match = /^Bearer ([A-Za-z0-9]{12})$/.exec(value ?? '')
	return match?.[1] ?? null
}

function authenticateRequest(request: Request, server: Bun.Server<SocketData>): WebToken | null {
	const token = web.authorizationToken(request)
	if (!token) return null
	return webTokens.authenticate(token, server.requestIP(request)?.address ?? 'unknown')
}

function command(args: string): { output?: string; error?: string } {
	const [action = '', ...rest] = args.trim().split(/\s+/)
	if (!action) {
		let tokens = webTokens.list()
		if (tokens.length === 0) tokens = [webTokens.ensureLocalToken()]
		const lines = ['Web interface:']
		for (const [index, token] of tokens.entries()) lines.push(`  ${index + 1}. ${web.urlForToken(token)}  · ${token.purpose}`)
		return { output: lines.join('\n') }
	}
	if (action === 'auth') {
		try {
			const token = webTokens.mint(rest.join(' ') || 'web token')
			return { output: `Web token created (${token.purpose}):\n${web.urlForToken(token)}` }
		} catch (error) {
			return { error: String(error) }
		}
	}
	if (action === 'revoke' && rest.length === 1 && /^\d+$/.test(rest[0]!)) {
		const token = webTokens.revoke(Number(rest[0]))
		return token ? { output: `Revoked web token ${rest[0]} (${token.purpose}).` } : { error: `No web token ${rest[0]}.` }
	}
	return { error: 'Usage: /web | /web auth [purpose…] | /web revoke <number>' }
}

function urlForToken(token: WebToken, port = state.port): string {
	return `http://localhost:${port}/?auth=${token.token}`
}

function start(port: number, signal: AbortSignal, announcementSessionId?: string): void {
	if (state.server) {
		web.announce(announcementSessionId, state.port)
		return
	}
	webTokens.init()
	const sockets = new Map<string, Set<Bun.ServerWebSocket<SocketData>>>()
	const unsubscribeRevocation = webTokens.onRevoke((token) => {
		for (const socket of sockets.get(token.token) ?? []) socket.close(4001, 'Web token revoked')
	})
	let server: Bun.Server<SocketData>
	for (let tries = 1;; tries++) {
		try {
			server = Bun.serve<SocketData>({
				hostname: '127.0.0.1',
				port,
				fetch: async (request, server) => {
					const url = new URL(request.url)
					if (url.pathname === '/') return new Response(await web.pageHtml(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
					if (url.pathname === '/styles.css') return new Response(await web.styleCss(), { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' } })
					if (url.pathname === '/main.js') {
						try { return new Response(await web.bundleClient(), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } }) }
						catch (error) { return new Response(`Web client build failed: ${String(error)}`, { status: 500 }) }
					}
					if (url.pathname === '/ws') {
						if (server.upgrade(request, { data: { id: crypto.randomUUID(), ip: server.requestIP(request)?.address ?? 'unknown' } })) return
						return new Response('WebSocket upgrade required', { status: 426 })
					}
					if (!web.authenticateRequest(request, server)) return new Response('Web authentication required', { status: 401 })
					if (url.pathname === '/api/state' && request.method === 'GET') return Response.json(ipc.readState())
					if (url.pathname === '/api/session' && request.method === 'GET') return snapshotResponse(url.searchParams.get('id') ?? '')
					if (url.pathname === '/api/prompt' && request.method === 'POST') {
						if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return new Response('Expected application/json', { status: 415 })
						let body: any
						try { body = await request.json() } catch { return new Response('Expected JSON', { status: 400 }) }
						if (!body || typeof body.sessionId !== 'string' || typeof body.text !== 'string' || !body.text || body.text.length > 100_000 || !openSession(body.sessionId)) return new Response('Invalid prompt', { status: 400 })
						runtime.handleCommand({ type: 'prompt', sessionId: body.sessionId, text: body.text })
						return new Response(null, { status: 204 })
					}
					return new Response('Not found', { status: 404 })
				},
				websocket: {
					maxPayloadLength: 1_000_000,
					open() {},
					message(ws, raw) {
						const message = web.parseClientMessage(String(raw))
						if (!message) return
						if (!ws.data.token) {
							if (message.type !== 'authenticate') return ws.close(4003, 'Web authentication required')
							if (!webTokens.authenticate(message.token, ws.data.ip)) {
								ws.send(web.encode({ type: 'unauthorized' }))
								return ws.close(4003, 'Invalid web token')
							}
							ws.data.token = message.token
							let tokenSockets = sockets.get(message.token)
							if (!tokenSockets) {
								tokenSockets = new Set()
								sockets.set(message.token, tokenSockets)
							}
							tokenSockets.add(ws)
							ws.send(web.encode({ type: 'authenticated' }))
							ws.subscribe('web')
							ws.send(web.encode({ type: 'state', state: ipc.readState() }))
							return
						}
						if (message.type !== 'subscribe' || !openSession(message.sessionId)) return
						// Subscribe first, then take the synchronous snapshot. Events cannot interleave
						// with this callback, so every later event follows this exact baseline.
						if (ws.data.sessionId) ws.unsubscribe(web.sessionTopic(ws.data.sessionId))
						ws.data.sessionId = message.sessionId
						ws.subscribe(web.sessionTopic(message.sessionId))
						const snapshot = web.sessionSnapshot(message.sessionId)
						if (snapshot) ws.send(web.encode({ type: 'snapshot', snapshot }))
					},
					close(ws) {
						if (!ws.data.token) return
						const tokenSockets = sockets.get(ws.data.token)
						tokenSockets?.delete(ws)
						if (tokenSockets?.size === 0) sockets.delete(ws.data.token)
					},
				},
			})
			break
		} catch (error: any) {
			if (error?.code !== 'EADDRINUSE' || tries === 10) {
				unsubscribeRevocation()
				throw error
			}
			port = web.nextPort(port, tries)
		}
	}
	state.server = server
	state.port = server.port ?? port
	void (async () => {
		for await (const event of ipc.tailEvents(signal)) {
			server.publish('web', web.encode({ type: 'state', state: ipc.readState() }))
			const sessionId = event && typeof event.sessionId === 'string' ? event.sessionId : ''
			if (!sessionId) continue
			const live = web.liveEventMessage(event)
			if (live) server.publish(web.sessionTopic(sessionId), web.encode(live))
			if (!web.isSnapshotBoundary(event)) continue
			const snapshot = web.sessionSnapshot(sessionId)
			if (snapshot) server.publish(web.sessionTopic(sessionId), web.encode({ type: 'snapshot', snapshot }))
		}
	})()
	signal.addEventListener('abort', () => {
		unsubscribeRevocation()
		server.stop()
		if (state.server === server) {
			state.server = null
			state.port = 0
		}
	}, { once: true })
	web.announce(announcementSessionId, state.port)
}

export const web = {
	state,
	start,
	command,
	nextPort,
	urlForToken,
	announce,
	authorizationToken,
	authenticateRequest,
	pageHtml,
	styleCss,
	bundleClient,
	hydrateHistory,
	sessionSnapshot,
	parseClientMessage,
	isLiveEvent,
	liveEventMessage,
	isSnapshotBoundary,
	encode,
	sessionTopic,
}
