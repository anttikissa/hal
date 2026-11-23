// Exposes Hal's session, coordination and plugin tools to an `agy acp`
// process over its `--ide-mcp-port` loopback TCP socket (newline-delimited
// JSON-RPC 2.0 MCP, spoken through `nc`). agy keeps its own file/shell
// tools, so Hal omits those and exposes the rest according to the
// session's tool list. Task xbp.

import { readFileSync } from 'fs'
import type { Socket } from 'bun'
import { blocks } from '../common/blocks.ts'
import { blobs } from './blobs.ts'
import { diag } from './diag.ts'
import { sessions } from './sessions.ts'
import { tools, type Tool } from './tools.ts'

export type McpBridge = { port: number; stop(): void }
export type McpResult = { name: string; output: string; isError?: boolean }

type RpcRequest = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, any> }
type SocketState = { buf: string }

const excluded = new Set(['bash', 'read', 'edit', 'grep', 'help'])

function describe(tool: Tool<unknown>): string {
	let head = tool.description ?? tool.summary ?? tool.name
	if (!tool.help) return head
	let body = tool.help
		.replace(/^:::.*$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
	return body ? `${head}\n\n${body}` : head
}

function list(sessionId: string): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
	return tools
		.allowed(sessionId)
		.filter((t) => !agyMcp.excluded.has(t.name))
		.map((t) => ({
			name: t.name,
			description: describe(t),
			inputSchema: t.parameters ?? { type: 'object', properties: {} },
		}))
}

async function call(
	sessionId: string,
	name: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
): Promise<{ content: Record<string, unknown>[]; isError?: boolean }> {
	if (agyMcp.excluded.has(name) || !tools.allowed(sessionId).some((t) => t.name === name))
		return {
			content: [{ type: 'text', text: `Tool '${name}' is not available in this Hal session.` }],
			isError: true,
		}
	let meta = sessions.open(sessionId)
	let result = await tools.run(
		{ type: 'tool_call', id: crypto.randomUUID(), name, input: args },
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
				capabilities: { tools: {} },
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

// `getSignal` gives the running turn's signal; Hal tools run only then.
function start(
	sessionId: string,
	getSignal: () => AbortSignal | undefined,
	onResult?: (res: McpResult) => void,
): McpBridge {
	let sockets = new Set<Socket<SocketState>>()
	let decoder = new TextDecoder()
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
				socket.data = { buf: '' }
				sockets.add(socket)
			},
			data(socket, chunk) {
				if (!sockets.has(socket)) return
				socket.data.buf += decoder.decode(chunk, { stream: true })
				let lines = socket.data.buf.split('\n')
				socket.data.buf = lines.pop()!
				for (let line of lines) {
					if (!line.trim()) continue
					let msg: RpcRequest
					try {
						msg = JSON.parse(line)
					} catch {
						continue
					}
					void agyMcp
						.handle(sessionId, msg, getSignal, onResult)
						.then((res) => {
							if (res && sockets.has(socket)) socket.write(JSON.stringify(res) + '\n')
						})
						.catch((e) => diag.log(`agy-mcp ${sessionId}: ${e instanceof Error ? e.message : e}`))
				}
			},
			close(socket) {
				sockets.delete(socket)
			},
			error(socket) {
				sockets.delete(socket)
			},
		},
	})
	return {
		port: server.port,
		stop() {
			for (let s of sockets)
				try {
					s.end()
				} catch {}
			sockets.clear()
			server.stop(true)
		},
	}
}

export const agyMcp = { excluded, list, call, handle, peerUid, start }
