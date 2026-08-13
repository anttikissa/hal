// Local browser client. This module is imported only for `hal --web`; browser code
// is bundled lazily on the first request so it never affects normal startup.

import type { ClientSessionSnapshot } from '../common/snapshots.ts'
import { ipc } from '../ipc.ts'
import { runtime } from './runtime.ts'
import { sessions } from './sessions.ts'

function pageHtml(): Promise<string> {
	return Bun.file(`${import.meta.dir}/../web-client/main.html`).text()
}

let clientBuild: Promise<string> | null = null

function openSession(sessionId: string): boolean {
	return ipc.readState().sessions.some((session) => session.id === sessionId)
}

function sessionSnapshot(sessionId: string): ClientSessionSnapshot | null {
	const session = ipc.readState().sessions.find((item) => item.id === sessionId)
	if (!session) return null
	return {
		session,
		history: sessions.loadAllHistory(sessionId),
		live: sessions.loadLive(sessionId).blocks,
	}
}

function snapshotResponse(sessionId: string): Response {
	const snapshot = web.sessionSnapshot(sessionId)
	if (!snapshot) return new Response('Unknown open session', { status: 404 })
	return Response.json(snapshot)
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

function start(port: number, signal: AbortSignal): void {
	let server: Bun.Server<{ id: string }>
	for (let tries = 1;; tries++) {
		try {
		server = Bun.serve<{ id: string }>({
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
			open(ws) { ws.subscribe('web') },
			message() {},
		},
		})
			break
		} catch (error: any) {
			if (error?.code !== 'EADDRINUSE' || tries === 10) throw error
			port = nextPort(port, tries)
		}
	}
	void (async () => {
		for await (const event of ipc.tailEvents(signal)) server.publish('web', JSON.stringify({ sessionId: (event as any).sessionId }))
	})()
	signal.addEventListener('abort', () => server.stop(), { once: true })
	runtime.emitInfo(ipc.readState().sessions[0]?.id ?? '', `Web client: http://127.0.0.1:${port}`)
}

export const web = { start, nextPort, pageHtml, sessionSnapshot }
