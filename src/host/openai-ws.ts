// OpenAI Responses over WebSocket, as the Codex CLI speaks it (task ak5,
// codex-rs/core/src/client.rs): one socket per session; a request that
// extends the previous one sends only the new input items with
// previous_response_id, so long tool loops stop re-uploading the whole
// conversation. Messages are fed back as SSE bytes, so provider.ts keeps
// its timeouts, abort and parse unchanged. Anything unexpected closes
// the socket; the next request starts over with the full input, and a
// failed connect falls back to HTTP for a while.

import type { HttpRequest, ProviderRequest } from './provider.ts'
import { diag } from './diag.ts'

type Socket = {
	key: string
	ws: WebSocket
	opened: Promise<boolean>
	busy: boolean
	// The last completed request: its non-input fields, full input as
	// JSON items, and the response id that continues it.
	last?: { fields: string; input: string[]; count: number; id: string }
	idle?: ReturnType<typeof setTimeout>
}

const BETA = 'responses_websockets=2026-02-06'
// Codex-side errors after which the same request succeeds on a fresh
// socket with full input.
const RESTART = new Set(['previous_response_not_found', 'websocket_connection_limit_reached'])

const state = {
	sockets: new Map<string, Socket>(),
	httpUntil: 0,
	// Sessions whose socket died mid-response (e.g. 1009, message too
	// big): they stay on HTTP, as pi does, so the retry cannot loop.
	httpSessions: new Set<string>(),
	connectMs: 10_000,
	idleMs: 10 * 60_000,
	fallbackMs: 10 * 60_000,
	enabled: true,
}

function close(id: string): void {
	let s = state.sockets.get(id)
	if (!s) return
	state.sockets.delete(id)
	clearTimeout(s.idle)
	try {
		s.ws.close()
	} catch {}
}

function connect(url: string, headers: Record<string, string>): Pick<Socket, 'ws' | 'opened'> {
	let ws = new WebSocket(url.replace(/^http/, 'ws'), { headers: { ...headers, 'OpenAI-Beta': BETA } } as unknown as string[])
	let opened = new Promise<boolean>((resolve) => {
		let timer = setTimeout(() => resolve(false), state.connectMs)
		let end = (ok: boolean) => () => (clearTimeout(timer), resolve(ok))
		ws.addEventListener('open', end(true), { once: true })
		ws.addEventListener('error', end(false), { once: true })
		ws.addEventListener('close', end(false), { once: true })
	})
	return { ws, opened }
}

// The input to send: only what follows the previous request and its
// reply, when everything else is unchanged; else everything.
function continuation(s: Socket, fields: string, full: unknown[], req: ProviderRequest, items: (req: ProviderRequest) => unknown[]) {
	let last = s.last
	if (!last || last.fields !== fields) return undefined
	let reply = req.messages[last.count]
	let replyItems = reply?.role === 'assistant' ? items({ ...req, messages: [reply] }).length : 0
	let start = last.input.length + replyItems
	if (full.length <= start) return undefined
	for (let i = 0; i < last.input.length; i++) if (JSON.stringify(full[i]) !== last.input[i]) return undefined
	return { previous_response_id: last.id, input: full.slice(start) }
}

// A stream of SSE bytes for this request over the session's socket, or
// undefined to use HTTP.
async function open(http: HttpRequest, req: ProviderRequest, items: (req: ProviderRequest) => unknown[]): Promise<ReadableStream<Uint8Array> | undefined> {
	let id = req.sessionId
	if (!state.enabled || !id || Date.now() < state.httpUntil || state.httpSessions.has(id)) return undefined
	let { input: full, ...rest } = http.body as { input: unknown[] } & Record<string, unknown>
	let key = JSON.stringify([http.url, http.account, http.headers['chatgpt-account-id']])
	let s = state.sockets.get(id)
	if (s && (s.key !== key || s.ws.readyState > WebSocket.OPEN)) {
		close(id)
		s = undefined
	}
	if (s?.busy) return undefined
	if (!s) {
		s = { key, busy: false, ...connect(http.url, http.headers) }
		state.sockets.set(id, s)
	}
	let socket = s
	socket.busy = true
	clearTimeout(socket.idle)
	if (!(await socket.opened)) {
		close(id)
		state.httpUntil = Date.now() + state.fallbackMs
		diag.log(`OpenAI WebSocket connect to ${http.url} failed; using HTTP for ${state.fallbackMs / 60_000} min`)
		return undefined
	}
	let fields = JSON.stringify(rest)
	let next = continuation(socket, fields, full, req, items)
	let body = { type: 'response.create', ...rest, ...(next ?? { input: full }) }
	let sent = { fields, input: full.map((item) => JSON.stringify(item)), count: req.messages.length }
	socket.last = undefined
	let ws = socket.ws
	let encoder = new TextEncoder()
	let active: string | undefined
	let finished = false
	let ctrl!: ReadableStreamDefaultController<Uint8Array>
	let stop = (keep: boolean) => {
		finished = true
		ws.removeEventListener('message', onMessage)
		ws.removeEventListener('close', onClose)
		socket.busy = false
		if (!keep) return close(id)
		socket.idle = setTimeout(() => close(id), state.idleMs)
		;(socket.idle as { unref?: () => void }).unref?.()
	}
	let fail = (message: string) => {
		stop(false)
		ctrl.error(new Error(message))
	}
	let onMessage = (e: MessageEvent) => {
		let data = String(e.data)
		let ev: any
		try {
			ev = JSON.parse(data)
		} catch {
			return fail(`OpenAI WebSocket sent invalid JSON: ${data.slice(0, 500)}`)
		}
		if (ev.type === 'error') {
			let code = ev.error?.code ?? ev.code
			// A stale continuation or the 60-minute socket limit: the retry
			// sends the full input on a new socket.
			if (RESTART.has(code)) return fail(`OpenAI WebSocket: ${ev.error?.message ?? code}`)
		}
		else if (ev.type === 'response.created') {
			// A socket can replay an older response; read only the one just asked for.
			if ((ev.response?.previous_response_id ?? undefined) !== (body as { previous_response_id?: string }).previous_response_id) return
			active = ev.response?.id
		}
		else if (!active || (ev.response?.id && ev.response.id !== active)) return
		ctrl.enqueue(encoder.encode(`data: ${data.replace(/\n/g, '\ndata: ')}\n\n`))
		if (ev.type === 'response.completed' && active) {
			socket.last = { ...sent, id: active }
			stop(true)
			ctrl.close()
		}
		else if (ev.type === 'error' || ev.type === 'response.failed' || ev.type === 'response.incomplete') {
			stop(false)
			ctrl.close()
		}
	}
	let onClose = (e: CloseEvent) => {
		state.httpSessions.add(id)
		diag.log(`OpenAI WebSocket of ${id} closed mid-response (code ${e.code}); the session uses HTTP`)
		fail(`OpenAI WebSocket closed before the response finished (code ${e.code}${e.reason ? `: ${e.reason}` : ''})`)
	}
	return new ReadableStream<Uint8Array>({
		start(c) {
			ctrl = c
			ws.addEventListener('message', onMessage)
			ws.addEventListener('close', onClose)
			try {
				ws.send(JSON.stringify(body))
			} catch (e) {
				fail(`OpenAI WebSocket send failed: ${e instanceof Error ? e.message : String(e)}`)
			}
		},
		// The reader stopped early (abort, timeout, error event): the
		// socket's state is unknown, so drop it.
		cancel() {
			if (!finished) stop(false)
		},
	})
}

export const openaiWs = { state, open, close }
