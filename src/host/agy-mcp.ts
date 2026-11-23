// Exposes Hal's session, coordination and plugin tools to an `agy acp`
// process over its `--ide-mcp-port` loopback TCP socket (newline-delimited
// JSON-RPC 2.0 MCP, spoken through `nc`). agy keeps its own file/shell
// tools, so Hal omits those and exposes the rest according to the
// session's tool list. Task xbp.

import type { Socket } from 'bun'
import { blocks } from '../common/blocks.ts'
import { blobs } from './blobs.ts'
import { diag } from './diag.ts'
import { sessions } from './sessions.ts'
import { tools, type Tool } from './tools.ts'

export type McpBridge = { port: number; stop(): void }

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
	getSignal: () => AbortSignal,
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
				return reply(await agyMcp.call(sessionId, name, args, getSignal()))
			} catch (e) {
				return reply({
					content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
					isError: true,
				})
			}
		}
		default:
			return fail(-32601, `Method not found: ${msg.method}`)
	}
}

function start(sessionId: string, getSignal: () => AbortSignal): McpBridge {
	let sockets = new Set<Socket<SocketState>>()
	let decoder = new TextDecoder()
	let server = Bun.listen<SocketState>({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			open(socket) {
				socket.data = { buf: '' }
				sockets.add(socket)
			},
			data(socket, chunk) {
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
						.handle(sessionId, msg, getSignal)
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

export const agyMcp = { excluded, list, call, handle, start }
