// Local browser client. This module is imported only for `hal --web`; browser code
// is bundled lazily on the first request so it never affects normal startup.

import { ipc } from '../ipc.ts'
import { runtime } from '../server/runtime.ts'
import { sessions } from '../server/sessions.ts'

const page = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>HAL</title><style>body{margin:auto;max-width:900px;font:15px system-ui;background:#111;color:#eee}header,form{display:flex;gap:8px;padding:12px;border-bottom:1px solid #444}#tabs{overflow:auto;white-space:nowrap}button,input{font:inherit;padding:8px;background:#222;color:inherit;border:1px solid #555}button{cursor:pointer}button.selected{background:#456}main{padding:12px;white-space:pre-wrap;overflow-wrap:anywhere}article{padding:10px 0;border-bottom:1px solid #333}.user{color:#9cf}.assistant{color:#eee}.info{color:#aaa}label{font-size:12px;color:#aaa}</style><header id="tabs"></header><main id="messages"></main><form id="form"><input id="prompt" autocomplete="off" placeholder="Message" autofocus><button>Send</button></form><script type="module" src="/main.js"></script>`

let clientBuild: Promise<string> | null = null

function openSession(sessionId: string): boolean {
	return ipc.readState().sessions.some((session) => session.id === sessionId)
}

function textEntry(entry: any): { type: string; text: string } | null {
	if (entry.type === 'user') {
		const text = entry.parts?.filter((part: any) => part.type === 'text').map((part: any) => part.displayText ?? part.text).join('\n') ?? ''
		return text ? { type: 'user', text } : null
	}
	if (['assistant', 'info', 'log', 'warning', 'error'].includes(entry.type) && typeof entry.text === 'string') return { type: entry.type, text: entry.text }
	return null
}

function snapshot(sessionId: string): Response {
	if (!openSession(sessionId)) return new Response('Unknown open session', { status: 404 })
	const history = sessions.loadAllHistory(sessionId).map(textEntry).filter(Boolean)
	const live = sessions.loadLive(sessionId).blocks.filter((block: any) => typeof block.text === 'string').map((block: any) => ({ type: block.type, text: block.text }))
	return Response.json({ sessions: ipc.readState(), history, live })
}

async function bundleClient(): Promise<string> {
	clientBuild ??= Bun.build({ entrypoints: [`${import.meta.dir}/main.js`], target: 'browser', minify: true }).then(async (result) => {
		if (!result.success || !result.outputs[0]) throw new Error(result.logs.map(String).join('\n'))
		return result.outputs[0].text()
	})
	return clientBuild
}

function start(port: number, signal: AbortSignal): void {
	const server = Bun.serve<{ id: string }>({
		hostname: '127.0.0.1',
		port,
		fetch: async (request, server) => {
			const url = new URL(request.url)
			if (url.pathname === '/') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
			if (url.pathname === '/main.js') {
				try { return new Response(await bundleClient(), { headers: { 'content-type': 'text/javascript; charset=utf-8' } }) }
				catch (error) { return new Response(`Web client build failed: ${String(error)}`, { status: 500 }) }
			}
			if (url.pathname === '/api/state' && request.method === 'GET') return Response.json(ipc.readState())
			if (url.pathname === '/api/session' && request.method === 'GET') return snapshot(url.searchParams.get('id') ?? '')
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
	void (async () => {
		for await (const event of ipc.tailEvents(signal)) server.publish('web', JSON.stringify({ sessionId: (event as any).sessionId }))
	})()
	signal.addEventListener('abort', () => server.stop(), { once: true })
	runtime.emitInfo(ipc.readState().sessions[0]?.id ?? '', `Web client: http://127.0.0.1:${port}`)
}

export const web = { start }
