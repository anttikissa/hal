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

function pageHtml(): Promise<string> {
	return Bun.file(`${import.meta.dir}/../web-client/main.html`).text()
}

let clientBuild: Promise<string> | null = null

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
	if (message.type !== 'subscribe' || typeof message.sessionId !== 'string' || !message.sessionId) return null
	return { type: 'subscribe', sessionId: message.sessionId }
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
	clientBuild ??= Bun.build({ entrypoints: [`${import.meta.dir}/../web-client/main.js`], target: 'browser', minify: true }).then(async (result) => {
		if (!result.success || !result.outputs[0]) throw new Error(result.logs.map(String).join('\n'))
		return result.outputs[0].text()
	})
	return clientBuild
}

function nextPort(previousPort: number, tries: number, random = Math.random): number {
	return previousPort + Math.floor((1 + random() * 2) ** tries)
}

function announce(sessionId: string | undefined, port: number): void {
	if (!sessionId) return
	runtime.emitInfo(sessionId, `Web interface available at http://127.0.0.1:${port}/`)
}

function start(port: number, signal: AbortSignal, announcementSessionId?: string): void {
	let server: Bun.Server<{ id: string; sessionId?: string }>
	for (let tries = 1;; tries++) {
		try {
			server = Bun.serve<{ id: string; sessionId?: string }>({
				hostname: '127.0.0.1',
				port,
				fetch: async (request, server) => {
					const url = new URL(request.url)
					if (url.pathname === '/') return new Response(await web.pageHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } })
					if (url.pathname === '/main.js') {
						try { return new Response(await bundleClient(), { headers: { 'content-type': 'text/javascript; charset=utf-8' } }) }
						catch (error) { return new Response(`Web client build failed: ${String(error)}`, { status: 500 }) }
					}
					if (url.pathname === '/api/state' && request.method === 'GET') return Response.json(ipc.readState())
					if (url.pathname === '/api/session' && request.method === 'GET') return snapshotResponse(url.searchParams.get('id') ?? '')
					if (url.pathname === '/api/prompt' && request.method === 'POST') {
						let body: any
						try { body = await request.json() } catch { return new Response('Expected JSON', { status: 400 }) }
						if (!body || typeof body.sessionId !== 'string' || typeof body.text !== 'string' || !body.text || body.text.length > 100_000 || !openSession(body.sessionId)) return new Response('Invalid prompt', { status: 400 })
						runtime.handleCommand({ type: 'prompt', sessionId: body.sessionId, text: body.text })
						return new Response(null, { status: 204 })
					}
					if (url.pathname === '/ws' && server.upgrade(request, { data: { id: crypto.randomUUID() } })) return
					return new Response('Not found', { status: 404 })
				},
				websocket: {
					maxPayloadLength: 1_000_000,
					open(ws) {
						ws.subscribe('web')
						ws.send(web.encode({ type: 'state', state: ipc.readState() }))
					},
					message(ws, raw) {
						const message = web.parseClientMessage(String(raw))
						if (!message || !openSession(message.sessionId)) return
						// Subscribe first, then take the synchronous snapshot. Events cannot interleave
						// with this callback, so every later event follows this exact baseline.
						if (ws.data.sessionId) ws.unsubscribe(web.sessionTopic(ws.data.sessionId))
						ws.data.sessionId = message.sessionId
						ws.subscribe(web.sessionTopic(message.sessionId))
						const snapshot = web.sessionSnapshot(message.sessionId)
						if (snapshot) ws.send(web.encode({ type: 'snapshot', snapshot }))
					},
				},
			})
			break
		} catch (error: any) {
			if (error?.code !== 'EADDRINUSE' || tries === 10) throw error
			port = nextPort(port, tries)
		}
	}
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
	signal.addEventListener('abort', () => server.stop(), { once: true })
	web.announce(announcementSessionId, port)
}

export const web = {
	start,
	nextPort,
	announce,
	pageHtml,
	hydrateHistory,
	sessionSnapshot,
	parseClientMessage,
	isLiveEvent,
	liveEventMessage,
	isSnapshotBoundary,
	encode,
	sessionTopic,
}
