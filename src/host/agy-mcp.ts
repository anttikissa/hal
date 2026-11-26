// Exposes Hal's session, coordination, help and plugin tools to an `agy acp`
// process over its `--ide-mcp-port` loopback TCP socket (newline-delimited
// JSON-RPC 2.0 MCP, spoken through `nc`). agy keeps its own file/shell
// tools, so Hal omits those and exposes the rest according to the
// session's tool list. Task xbp.

import { readFileSync } from 'fs'
import type { Socket } from 'bun'
import { blocks } from '../common/blocks.ts'
import { blobs } from './blobs.ts'
import { diag } from './diag.ts'
import { nativeTool } from './native-tool.ts'
import { promptCache } from './prompt-cache.ts'
import { sessions } from './sessions.ts'
import { systemPrompt } from './system-prompt.ts'
import { tools, type Tool } from './tools.ts'

export type McpBridge = { port: number; notifyToolsChanged(): void; stop(): void }
export type McpResult = { name: string; output: string; isError?: boolean }

type RpcRequest = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, any> }
type SocketState = { buf: string; decoder: TextDecoder; pending: Uint8Array[] }

const excluded = new Set(['bash', 'read', 'edit', 'grep'])
const bridges = new Set<McpBridge>()
const encoder = new TextEncoder()

function describe(tool: Tool<unknown>, sessionId: string): string {
	let head = tool.description ?? tool.summary
	if (!tool.help) return head ?? tool.name
	let open = sessions.state.open.has(sessionId)
	let interactive = open ? promptCache.interactive(sessionId) : true
	let vars = open ? systemPrompt.vars(promptCache.input(sessionId, { interactive })) : {}
	let body = nativeTool.guide(tool, interactive, vars)
	if (open) {
		let problems: string[] = []
		let rendered = systemPrompt.template(body, problems)
		if (!problems.length) body = rendered
	}
	body = body
		.replace(/^:::.*$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
	if (!body) return head ?? tool.name
	return head ? `${head}\n\n${body}` : body
}

function list(sessionId: string): {
	name: string
	description: string
	inputSchema: Record<string, unknown>
	annotations?: { readOnlyHint: true }
}[] {
	return tools
		.allowed(sessionId)
		.filter((t) => !agyMcp.excluded.has(t.name))
		.map((t) => ({
			name: t.name,
			description: agyMcp.describe(t, sessionId),
			inputSchema: t.parameters ?? { type: 'object', properties: {} },
			...(tools.readOnly(t.name) && { annotations: { readOnlyHint: true as const } }),
		}))
}

async function call(
	sessionId: string,
	name: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
): Promise<{ content: Record<string, unknown>[]; isError?: boolean }> {
	let found = tools.allowed(sessionId).find((t) => t.name === name)
	if (agyMcp.excluded.has(name) || !found)
		return {
			content: [{ type: 'text', text: `Tool '${name}' is not available in this Hal session.` }],
			isError: true,
		}
	let props = (found.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
	let input = args
	if ('toolSummary' in args && (!props || !Object.hasOwn(props, 'toolSummary'))) {
		input = { ...args }
		delete input.toolSummary
	}
	let meta = sessions.open(sessionId)
	let result = await tools.run(
		{ type: 'tool_call', id: crypto.randomUUID(), name, input },
		{ cwd: meta.cwd, sessionId, model: meta.model, signal },
	)
	let content: Record<string, unknown>[] = [{ type: 'text', text: result.output }]
	for (let img of blocks.resultImages(result)) {
		let stored = blobs.read(sessionId, img.blob)
		if (stored) content.push({ type: 'image', data: stored.bytes.toString('base64'), mimeType: stored.mediaType })
	}
	return { content, ...(result.isError && { isError: true }) }
}

async function handle(
	sessionId: string,
	msg: RpcRequest,
	getSignal: () => AbortSignal | undefined,
	onResult?: (res: McpResult) => void,
): Promise<Record<string, unknown> | undefined> {
	if (msg.id === undefined) return undefined
	let reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
	let fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
	switch (msg.method) {
		case 'initialize':
			return reply({
				protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
				capabilities: { tools: { listChanged: true } },
				serverInfo: { name: 'hal', version: '1.0.0' },
			})
		case 'ping':
			return reply({})
		case 'tools/list':
			return reply({ tools: agyMcp.list(sessionId) })
		case 'tools/call': {
			let name = typeof msg.params?.name === 'string' ? msg.params.name : ''
			let args =
				msg.params?.arguments && typeof msg.params.arguments === 'object' && !Array.isArray(msg.params.arguments)
					? (msg.params.arguments as Record<string, unknown>)
					: {}
			try {
				let signal = getSignal()
				if (!signal) throw new Error(`Hal tools run only during a turn of session ${sessionId}.`)
				let res = await agyMcp.call(sessionId, name, args, signal)
				let text = res.content
					.filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
					.map((c) => c.text)
					.join('\n')
				onResult?.({ name, output: text, ...(res.isError && { isError: true }) })
				return reply(res)
			} catch (e) {
				let text = `Error: ${e instanceof Error ? e.message : String(e)}`
				onResult?.({ name, output: text, isError: true })
				return reply({ content: [{ type: 'text', text }], isError: true })
			}
		}
		default:
			return fail(-32601, `Method not found: ${msg.method}`)
	}
}

// The OS user that owns the connecting loopback socket, from Linux's
// /proc/net/tcp; undefined elsewhere.
function peerUid(port: number, peerPort: number): number | undefined {
	let table: string
	try {
		table = readFileSync('/proc/net/tcp', 'utf8')
	} catch {
		return undefined
	}
	let hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')
	for (let line of table.split('\n').slice(1)) {
		let cols = line.trim().split(/\s+/)
		if (cols[1]?.endsWith(`:${hex(peerPort)}`) && cols[2]?.endsWith(`:${hex(port)}`)) return Number(cols[7])
	}
	return -1
}

function flush(socket: Socket<SocketState>): void {
	let queue = socket.data.pending
	while (queue.length) {
		let head = queue[0]!
		let written = socket.write(head)
		if (written <= 0) break
		if (written < head.byteLength) {
			queue[0] = head.subarray(written)
			break
		}
		queue.shift()
	}
}

function send(socket: Socket<SocketState>, sockets: Set<Socket<SocketState>>, msg: Record<string, unknown>): void {
	if (!sockets.has(socket)) return
	socket.data.pending.push(encoder.encode(`${JSON.stringify(msg)}\n`))
	if (socket.data.pending.length === 1) flush(socket)
}

function notifyToolsChanged(): void {
	for (let bridge of agyMcp.bridges) bridge.notifyToolsChanged()
}

// `getSignal` gives the running turn's signal; Hal tools run only then.
function start(
	sessionId: string,
	getSignal: () => AbortSignal | undefined,
	onResult?: (res: McpResult) => void,
): McpBridge {
	let sockets = new Set<Socket<SocketState>>()
	let dispatch = (socket: Socket<SocketState>, line: string) => {
		if (!line.trim()) return
		let msg: RpcRequest
		try {
			msg = JSON.parse(line)
		} catch {
			return
		}
		void agyMcp
			.handle(sessionId, msg, getSignal, onResult)
			.then((res) => {
				if (res) send(socket, sockets, res)
			})
			.catch((e) => diag.log(`agy-mcp ${sessionId}: ${e instanceof Error ? e.message : e}`))
	}
	let server = Bun.listen<SocketState>({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			open(socket) {
				let uid = agyMcp.peerUid(server.port, socket.remotePort)
				if (uid !== undefined && uid !== process.getuid?.()) {
					diag.log(`agy-mcp ${sessionId}: refused a connection from uid ${uid}`)
					return void socket.end()
				}
				socket.data = { buf: '', decoder: new TextDecoder(), pending: [] }
				sockets.add(socket)
			},
			data(socket, chunk) {
				if (!sockets.has(socket)) return
				socket.data.buf += socket.data.decoder.decode(chunk, { stream: true })
				let lines = socket.data.buf.split('\n')
				socket.data.buf = lines.pop()!
				for (let line of lines) dispatch(socket, line)
			},
			end(socket) {
				if (!sockets.has(socket)) return
				socket.data.buf += socket.data.decoder.decode()
				let tail = socket.data.buf
				socket.data.buf = ''
				if (tail) dispatch(socket, tail)
			},
			drain(socket) {
				if (sockets.has(socket)) flush(socket)
			},
			close(socket) {
				sockets.delete(socket)
			},
			error(socket) {
				sockets.delete(socket)
			},
		},
	})
	let bridge: McpBridge = {
		port: server.port,
		notifyToolsChanged() {
			for (let s of sockets) send(s, sockets, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
		},
		stop() {
			agyMcp.bridges.delete(bridge)
			for (let s of sockets)
				try {
					s.end()
				} catch {}
			sockets.clear()
			server.stop(true)
		},
	}
	agyMcp.bridges.add(bridge)
	return bridge
}

export const agyMcp = { excluded, bridges, describe, list, call, handle, peerUid, notifyToolsChanged, start }
