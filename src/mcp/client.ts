// Run MCP servers over stdio, then register their tools under a server-prefixed name.
// Stdout is newline-delimited JSON-RPC; notifications are ignored and responses
// resolve pending requests by id.

import { readFile } from 'fs/promises'
import { HAL_DIR } from '../state.ts'
import { toolRegistry, type Tool, type ToolContext } from '../tools/tool.ts'
import { ason } from '../utils/ason.ts'
import { log } from '../utils/log.ts'

const CONFIG_PATH = `${HAL_DIR}/mcp.ason`
// ── Types ──

interface ServerConfig {
	command: string
	args?: string[]
	env?: Record<string, string>
}

interface McpConfig {
	servers: Record<string, ServerConfig>
}

interface PendingRequest {
	resolve: (v: any) => void
	reject: (e: Error) => void
	timer: ReturnType<typeof setTimeout>
}

interface McpServer {
	name: string
	proc: ReturnType<typeof Bun.spawn>
	nextId: number
	pending: Map<number, PendingRequest>
	buffer: string // partial line accumulator for stdout parsing
	dead: boolean
}

// ── Config ──

const config = {
	requestTimeoutMs: 60_000,
	initTimeoutMs: 15_000,
}

// ── State ──

const state = {
	servers: new Map<string, McpServer>(),
	// Maps prefixed tool name → { server, originalName } so we can route
	// tool calls back to the correct server with the original unprefixed name.
	toolMap: new Map<string, { server: McpServer; originalName: string }>(),
}

// ── Config loading ──

async function loadConfig(): Promise<McpConfig | null> {
	try {
		const text = await readFile(CONFIG_PATH, 'utf-8')
		return ason.parse(text) as unknown as McpConfig
	} catch {
		return null
	}
}

// ── JSON-RPC transport ──

/** Send a JSON-RPC message to the server's stdin. */
function send(server: McpServer, method: string, params?: any, id?: number): void {
	const msg: any = { jsonrpc: '2.0', method }
	if (params !== undefined) msg.params = params
	if (id !== undefined) msg.id = id
	const line = JSON.stringify(msg) + '\n'
	const stdin = server.proc.stdin as import('bun').FileSink
	stdin.write(line)
	stdin.flush()
}

/** Send a JSON-RPC request and wait for the matching response. */
function request(server: McpServer, method: string, params?: any, timeoutMs = config.requestTimeoutMs): Promise<any> {
	if (server.dead) return Promise.reject(new Error(`MCP server "${server.name}" is dead`))
	const id = server.nextId++
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			server.pending.delete(id)
			reject(new Error(`MCP "${server.name}" request "${method}" timed out after ${timeoutMs}ms`))
		}, timeoutMs)
		server.pending.set(id, { resolve, reject, timer })
		send(server, method, params, id)
	})
}

// ── Stdout reader ──

/** Handle a single parsed JSON-RPC message from the server. */
function handleLine(server: McpServer, line: string): void {
	if (!line.trim()) return
	try {
		const msg = JSON.parse(line)
		// Only process responses (messages with an id). Notifications are ignored.
		if ('id' in msg && msg.id != null) {
			const pending = server.pending.get(msg.id)
			if (pending) {
				clearTimeout(pending.timer)
				server.pending.delete(msg.id)
				if (msg.error) {
					pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
				} else {
					pending.resolve(msg.result)
				}
			}
		}
	} catch {
		// Non-JSON lines are silently ignored (e.g. server debug output)
	}
}

/** Reject all pending requests — called when a server dies or shuts down. */
function rejectAll(server: McpServer, reason: string): void {
	server.dead = true
	for (const [, pending] of server.pending) {
		clearTimeout(pending.timer)
		pending.reject(new Error(reason))
	}
	server.pending.clear()
}

/** Continuously read stdout from the server process, splitting on newlines. */
async function readStdout(server: McpServer): Promise<void> {
	const reader = (server.proc.stdout as ReadableStream<Uint8Array>).getReader()
	const decoder = new TextDecoder()
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			server.buffer += decoder.decode(value, { stream: true })
			// Split on newlines; the last element is the incomplete next line
			const lines = server.buffer.split('\n')
			server.buffer = lines.pop()!
			for (const line of lines) handleLine(server, line)
		}
	} finally {
		rejectAll(server, `MCP server "${server.name}" stdout closed`)
	}
}

// ── Tool name prefixing ──

/** Build a prefixed tool name: mcp__<serverName>__<toolName> */
function prefixName(serverName: string, toolName: string): string {
	return `mcp__${serverName}__${toolName}`
}

// ── Server lifecycle ──

/** Launch a single MCP server, perform handshake, discover and register tools. */
async function startServer(name: string, cfg: ServerConfig): Promise<McpServer> {
	const proc = Bun.spawn([cfg.command, ...(cfg.args ?? [])], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'ignore',
		env: { ...process.env, ...cfg.env },
	})

	const server: McpServer = {
		name,
		proc,
		nextId: 1,
		pending: new Map(),
		buffer: '',
		dead: false,
	}

	// Start reading stdout in the background
	void readStdout(server)

	// MCP initialize handshake
	await request(
		server,
		'initialize',
		{
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'hal', version: '1.0.0' },
		},
		config.initTimeoutMs,
	)

	// Notify server that initialization is complete
	send(server, 'notifications/initialized')

	// Discover tools from this server
	const result = await request(server, 'tools/list', {})
	const tools = result.tools ?? []

	// Register each discovered tool into the global tool registry
	for (const t of tools) {
		const prefixed = prefixName(name, t.name)
		state.toolMap.set(prefixed, { server, originalName: t.name })

		// Build a Tool object that proxies execute() to the MCP server
		const tool: Tool = {
			name: prefixed,
			description: `[MCP: ${name}] ${t.description ?? ''}`.trim(),
			parameters: t.inputSchema?.properties ?? {},
			required: t.inputSchema?.required,
			execute: async (input: any, _ctx: ToolContext) => {
				return await callTool(prefixed, input)
			},
		}
		toolRegistry.registerTool(tool)
	}

	return server
}

// ── Public API ──

/** Initialize all MCP servers from mcp.ason. Safe to call if no config exists. */
async function initServers(): Promise<void> {
	const cfg = await loadConfig()
	if (!cfg?.servers) return

	const entries = Object.entries(cfg.servers)
	// Launch servers in parallel for faster startup
	const results = await Promise.allSettled(
		entries.map(async ([name, serverCfg]) => {
			if (state.servers.has(name)) return // already running
			const server = await startServer(name, serverCfg)
			state.servers.set(name, server)
		}),
	)

	// Log failures but don't crash
	for (let i = 0; i < results.length; i++) {
		const r = results[i]!
		if (r.status === 'rejected') {
			log.error('mcp server failed to start', { server: entries[i]![0], error: (r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason) })
		}
	}
}

/** Call an MCP tool by its prefixed name. Returns output text. */
async function callTool(prefixedName: string, args: any): Promise<string> {
	const entry = state.toolMap.get(prefixedName)
	if (!entry) return `error: unknown MCP tool "${prefixedName}"`

	try {
		const result = await request(entry.server, 'tools/call', {
			name: entry.originalName,
			arguments: args,
		})
		// MCP tool results contain a content array; concatenate text blocks
		if (result.content) {
			return result.content.map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
		}
		return JSON.stringify(result)
	} catch (err: any) {
		return `error: ${err.message}`
	}
}

/** Check whether a tool name belongs to an MCP server. */
function isMcpTool(name: string): boolean {
	return state.toolMap.has(name)
}

/** Shut down all MCP servers — kill child processes, reject pending requests. */
async function shutdown(): Promise<void> {
	for (const server of state.servers.values()) {
		rejectAll(server, 'shutting down')
		try {
			server.proc.kill()
		} catch {}
	}
	state.servers.clear()
	state.toolMap.clear()
}

export const mcp = { initServers, callTool, isMcpTool, shutdown, config, state }
