// One JSON-RPC connection to an MCP server (task sxf), over stdio (a child
// process speaking newline-delimited JSON) or streamable HTTP (POST, with
// replies as JSON or server-sent events). mcp.ts owns the MCP protocol on
// top; this module only matches replies to requests and reports failures
// with what the server said.

import { type ChildProcess, spawn } from 'child_process'
import { tools } from './tools.ts'

export type ServerConfig = {
	command?: string
	args?: string[]
	env?: Record<string, string>
	cwd?: string
	url?: string
	headers?: Record<string, string>
	timeout?: number
	enabled?: boolean
	// The OAuth bearer token (mcp-oauth.ts), refreshed when `stale`.
	authorize?: (stale: boolean) => Promise<string | undefined>
}
type RpcError = { code: number; message: string; data?: unknown }
type Message = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any; result?: any; error?: RpcError }
type Pending = { resolve(result: any): void; reject(error: Error): void }
type Handlers = { notification(method: string, params: any): void; closed(error: Error): void }
type Transport = { send(message: Message, signal?: AbortSignal): Promise<void>; close(): void; stderr(): string }
export type Peer = {
	name: string
	transport: Transport
	next: number
	pending: Map<number, Pending>
	closed?: Error
	protocol?: string
	handlers: Handlers
}

const stderrTail = 2000

// A request the server sent us is answered here: ping, or "not supported".
function answer(peer: Peer, message: Message): void {
	let reply: Message =
		message.method === 'ping'
			? { jsonrpc: '2.0', id: message.id, result: {} }
			: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Hal does not support ${message.method}` } }
	peer.transport.send(reply).catch(() => {})
}

function receive(peer: Peer, message: Message): void {
	if (message.method !== undefined) {
		if (message.id !== undefined) return mcpRpc.answer(peer, message)
		return peer.handlers.notification(message.method, message.params)
	}
	let pending = typeof message.id === 'number' ? peer.pending.get(message.id) : undefined
	if (!pending) return
	peer.pending.delete(message.id as number)
	if (message.error) pending.reject(mcpRpc.failure(peer, message.error))
	else pending.resolve(message.result)
}

// An error reply as one complete message: code, text and any data.
function failure(peer: Peer, error: RpcError): Error {
	let data =
		error.data === undefined ? '' : `\n${typeof error.data === 'string' ? error.data : JSON.stringify(error.data)}`
	return new Error(`${peer.name} answered error ${error.code}: ${error.message}${data}`)
}

// Fails every waiting request and tells the owner, once.
function close(peer: Peer, error: Error): void {
	if (peer.closed) return
	let tail = peer.transport.stderr().trim()
	peer.closed = tail ? new Error(`${error.message}\nstderr:\n${tail}`) : error
	for (let p of peer.pending.values()) p.reject(peer.closed)
	peer.pending.clear()
	peer.handlers.closed(peer.closed)
}

function stdio(peer: Peer, config: ServerConfig): Transport {
	let tail = ''
	let child: ChildProcess = spawn(config.command!, config.args ?? [], {
		cwd: config.cwd,
		env: { ...process.env, ...config.env },
		detached: true,
		stdio: ['pipe', 'pipe', 'pipe'],
	})
	let buffer = ''
	child.stdout!.setEncoding('utf8')
	child.stdout!.on('data', (chunk: string) => {
		buffer += chunk
		let lines = buffer.split('\n')
		buffer = lines.pop()!
		for (let line of lines) {
			if (!line.trim()) continue
			let message: Message
			try {
				message = JSON.parse(line)
			} catch {
				// Servers that log to stdout: keep it with stderr for errors.
				tail = (tail + line + '\n').slice(-stderrTail)
				continue
			}
			mcpRpc.receive(peer, message)
		}
	})
	child.stderr!.setEncoding('utf8')
	child.stderr!.on('data', (chunk: string) => (tail = (tail + chunk).slice(-stderrTail)))
	child.stdin!.on('error', () => {})
	child.on('error', (e) => mcpRpc.close(peer, new Error(`${peer.name}: cannot run ${config.command}: ${e.message}`)))
	child.on('exit', (code, signal) =>
		mcpRpc.close(peer, new Error(`${peer.name} exited with ${code === null ? signal : `code ${code}`}`)),
	)
	return {
		async send(message) {
			if (!child.stdin!.writable) throw peer.closed ?? new Error(`${peer.name} is not running`)
			child.stdin!.write(JSON.stringify(message) + '\n')
		},
		close() {
			if (child.pid && child.exitCode === null) tools.killGroup(child.pid)
		},
		stderr: () => tail,
	}
}

// Each event's data lines, joined, as they arrive.
async function events(body: ReadableStream<Uint8Array>, each: (data: string) => void): Promise<void> {
	let decoder = new TextDecoder()
	let buffer = ''
	let flush = (block: string) => {
		let data = block
			.split(/\r?\n/)
			.filter((l) => l.startsWith('data:'))
			.map((l) => l.slice(l[5] === ' ' ? 6 : 5))
		if (data.length) each(data.join('\n'))
	}
	for await (let chunk of body) {
		buffer += decoder.decode(chunk, { stream: true })
		let blocks = buffer.split(/\r?\n\r?\n/)
		buffer = blocks.pop()!
		blocks.forEach(flush)
	}
	flush(buffer)
}

function http(peer: Peer, config: ServerConfig): Transport {
	let session: string | undefined
	let deliver = (text: string) => {
		let parsed = JSON.parse(text)
		for (let message of Array.isArray(parsed) ? parsed : [parsed]) mcpRpc.receive(peer, message)
	}
	let headers = async (stale = false) => {
		let token = await config.authorize?.(stale)
		return {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...(token && { Authorization: `Bearer ${token}` }),
			...config.headers,
			...(session && { 'Mcp-Session-Id': session }),
			...(peer.protocol && { 'MCP-Protocol-Version': peer.protocol }),
		}
	}
	let post = async (message: Message, signal?: AbortSignal, stale = false) =>
		fetch(config.url!, { method: 'POST', headers: await headers(stale), body: JSON.stringify(message), signal })
	return {
		async send(message, signal) {
			let res = await post(message, signal)
			// A 401 was not processed: retry once with a refreshed token.
			if (res.status === 401 && config.authorize) {
				await res.body?.cancel()
				res = await post(message, signal, true)
			}
			session = res.headers.get('mcp-session-id') ?? session
			// A session the server no longer knows: mcp.ts starts a new one.
			if (res.status === 404 && session)
				throw Object.assign(new Error(`${peer.name}: session expired`), { expired: true })
			if (res.status === 401)
				throw new Error(
					`${peer.name} answered HTTP 401: ${await res.text()}\nIf it uses OAuth, log in with /mcp login ${peer.name}`,
				)
			if (!res.ok) throw new Error(`${peer.name} answered HTTP ${res.status}: ${await res.text()}`)
			let type = res.headers.get('content-type') ?? ''
			if (type.includes('text/event-stream') && res.body) await mcpRpc.events(res.body, deliver)
			else if (type.includes('json')) deliver(await res.text())
			else await res.body?.cancel()
		},
		close() {
			if (session)
				headers()
					.then((h) => fetch(config.url!, { method: 'DELETE', headers: h }))
					.catch(() => {})
		},
		stderr: () => '',
	}
}

function open(name: string, config: ServerConfig, handlers: Handlers): Peer {
	let peer: Peer = { name, next: 1, pending: new Map(), handlers, transport: undefined! }
	peer.transport = config.url ? mcpRpc.http(peer, config) : mcpRpc.stdio(peer, config)
	return peer
}

// Sends a request and waits for its reply. Aborting or timing out
// rejects it and tells the server to stop (notifications/cancelled).
function request(peer: Peer, method: string, params: object, timeoutMs: number, signal?: AbortSignal): Promise<any> {
	if (peer.closed) return Promise.reject(peer.closed)
	if (signal?.aborted) return Promise.reject(new Error('stopped'))
	let id = peer.next++
	let abort = new AbortController()
	let timer: ReturnType<typeof setTimeout>
	let reply = new Promise<any>((resolve, reject) => {
		peer.pending.set(id, { resolve, reject })
		let stop = (error: Error) => {
			if (!peer.pending.delete(id)) return
			reject(error)
			abort.abort()
			if (method !== 'initialize')
				mcpRpc.notify(peer, 'notifications/cancelled', { requestId: id, reason: error.message })
		}
		timer = setTimeout(
			() => stop(new Error(`${peer.name} did not answer ${method} in ${timeoutMs / 1000} s`)),
			timeoutMs,
		)
		signal?.addEventListener('abort', () => stop(new Error('stopped')), { once: true })
		peer.transport.send({ jsonrpc: '2.0', id, method, params }, abort.signal).catch((e: Error) => {
			if (abort.signal.aborted || !peer.pending.delete(id)) return
			reject(e)
		})
	})
	return reply.finally(() => clearTimeout(timer))
}

function notify(peer: Peer, method: string, params?: object): void {
	if (!peer.closed) peer.transport.send({ jsonrpc: '2.0', method, ...(params && { params }) }).catch(() => {})
}

function stop(peer: Peer): void {
	peer.transport.close()
	mcpRpc.close(peer, new Error(`${peer.name} was stopped`))
}

export const mcpRpc = { open, request, notify, stop, receive, answer, failure, close, stdio, http, events }
