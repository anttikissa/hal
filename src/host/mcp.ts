// Hal's MCP client (task sxf): the servers in the home file mcp.ason,
// each started on first use and kept for the host's life, with their
// tools listed and called for the MCP tool and /mcp.

import { liveFiles } from './live-file.ts'
import { mcpRpc, type Peer, type ServerConfig } from './mcp-rpc.ts'
import { mcpOauth } from './mcp-oauth.ts'
import { paths } from './paths.ts'
import type { ToolOutput } from './tools.ts'
import { version } from './version.ts'

type Schema = {
	type?: string | string[]
	enum?: unknown[]
	items?: Schema
	anyOf?: Schema[]
	oneOf?: Schema[]
	properties?: Record<string, Schema>
	required?: string[]
	description?: string
}
type McpTool = { name: string; description?: string; inputSchema?: Schema }
type Server = {
	config: string
	peer?: Peer
	starting?: Promise<Peer>
	tools: McpTool[]
	stale: boolean
	error?: string
}
type Content = {
	type: string
	text?: string
	data?: string
	mimeType?: string
	uri?: string
	name?: string
	resource?: { uri: string; mimeType?: string; text?: string; blob?: string }
}

const protocolVersion = '2025-06-18'
const defaultTimeout = 60

function path(): string {
	return `${paths.home()}/mcp.ason`
}

// Configured servers by name; a malformed mcp.ason is an error.
function configs(): Record<string, ServerConfig> {
	mcp.state.file ??= liveFiles.liveFile<{ mcpServers?: Record<string, ServerConfig> }>(
		mcp.path(),
		{},
		{ keepBroken: true },
	)
	let broken = liveFiles.brokenError(mcp.state.file)
	if (broken) throw broken
	return mcp.state.file.mcpServers ?? {}
}

// ${NAME} in env and header values comes from Hal's environment.
function expand(name: string, values?: Record<string, string>): Record<string, string> | undefined {
	if (!values) return undefined
	let one = (text: string) =>
		String(text).replace(/\$\{(\w+)\}/g, (_, v: string) => {
			if (process.env[v] === undefined) throw new Error(`${name} in ${mcp.path()} uses \${${v}}, which is not set`)
			return process.env[v]!
		})
	return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, one(v)]))
}

// The server's entry, and its state, restarted if its entry changed.
function server(name: string): { server: Server; config: ServerConfig } {
	let all = mcp.configs()
	let config = Object.hasOwn(all, name) ? all[name] : undefined
	if (!config) throw new Error(`no MCP server ${name}; ${mcp.path()} has: ${Object.keys(all).join(', ') || 'none'}`)
	if (config.enabled === false) throw new Error(`${name} is disabled in ${mcp.path()}`)
	if (!config.command && !config.url) throw new Error(`${name} in ${mcp.path()} needs a command or a url`)
	let key = JSON.stringify(config)
	let s = mcp.state.servers.get(name)
	if (s?.config !== key) {
		if (s) mcp.stop(name)
		s = { config: key, tools: [], stale: true }
		mcp.state.servers.set(name, s)
	}
	return { server: s, config }
}

function timeoutMs(config: ServerConfig): number {
	return (config.timeout ?? defaultTimeout) * 1000
}

async function start(name: string, s: Server, config: ServerConfig): Promise<Peer> {
	let resolved = {
		...config,
		// Live-file arrays are proxies, which spawn takes for options.
		args: config.args && [...config.args].map(String),
		env: mcp.expand(name, config.env),
		headers: mcp.expand(name, config.headers),
		cwd: config.cwd && paths.expand(config.cwd),
		...(config.url &&
			mcpOauth.store()[name]?.url === config.url && {
				authorize: (stale: boolean) => mcpOauth.token(name, config.url!, stale),
			}),
	}
	let peer = mcpRpc.open(name, resolved, {
		notification(method) {
			if (method === 'notifications/tools/list_changed') s.stale = true
		},
		closed(error) {
			if (s.peer === peer) s.peer = undefined
			s.error = error.message
		},
	})
	try {
		let init = await mcpRpc.request(
			peer,
			'initialize',
			{ protocolVersion, capabilities: {}, clientInfo: { name: 'hal', version: version.state.loaded ?? 'unknown' } },
			mcp.timeoutMs(config),
		)
		peer.protocol = init?.protocolVersion
		mcpRpc.notify(peer, 'notifications/initialized')
	} catch (e: any) {
		mcpRpc.stop(peer)
		s.error = e.message
		throw e
	}
	s.peer = peer
	s.error = undefined
	s.stale = true
	return peer
}

// The running connection, started if needed; concurrent callers share one start.
async function connect(name: string): Promise<{ server: Server; peer: Peer; timeout: number }> {
	let { server: s, config } = mcp.server(name)
	if (!s.peer) s.starting ??= mcp.start(name, s, config).finally(() => (s.starting = undefined))
	let peer = s.peer ?? (await s.starting!)
	return { server: s, peer, timeout: mcp.timeoutMs(config) }
}

// A request, sent again once in a new session when the server forgot
// ours (HTTP 404): the server rejected it unprocessed.
async function send(name: string, method: string, params: object, signal?: AbortSignal): Promise<any> {
	let { peer, timeout } = await mcp.connect(name)
	try {
		return await mcpRpc.request(peer, method, params, timeout, signal)
	} catch (e: any) {
		if (!e.expired) throw e
		mcpRpc.stop(peer)
		;({ peer, timeout } = await mcp.connect(name))
		return await mcpRpc.request(peer, method, params, timeout, signal)
	}
}

async function list(name: string, signal?: AbortSignal): Promise<McpTool[]> {
	let { server: s } = await mcp.connect(name)
	if (!s.stale) return s.tools
	let found: McpTool[] = []
	let cursor: string | undefined
	do {
		let page = await mcp.send(name, 'tools/list', cursor ? { cursor } : {}, signal)
		found.push(...(page?.tools ?? []))
		cursor = page?.nextCursor
	} while (cursor)
	s.tools = found
	s.stale = false
	return found
}

function typeName(schema: Schema = {}): string {
	if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ')
	let union = schema.anyOf ?? schema.oneOf
	if (union) return union.map(mcp.typeName).join(' | ')
	if (schema.type === 'array') return `${mcp.typeName(schema.items)}[]`
	return Array.isArray(schema.type) ? schema.type.join(' | ') : (schema.type ?? 'any')
}

// click(uid: string, dblClick?: boolean)
function signature(tool: McpTool): string {
	let { properties = {}, required = [] } = tool.inputSchema ?? {}
	let params = Object.entries(properties).map(([k, p]) => `${k}${required.includes(k) ? '' : '?'}: ${mcp.typeName(p)}`)
	return `${tool.name}(${params.join(', ')})`
}

// A server's tools, one signature and the description's first line each.
async function tools(name: string, signal?: AbortSignal): Promise<string> {
	let found = await mcp.list(name, signal)
	if (!found.length) return `${name} has no tools`
	let lines = found.map((t) => {
		let first = t.description?.trim().split('\n')[0]
		return first ? `${mcp.signature(t)}\n  ${first}` : mcp.signature(t)
	})
	return `${lines.join('\n')}\n\nMCP "${name}.<tool>" describes one; MCP "${name}.<tool>" { <arguments> } calls it.`
}

async function find(name: string, tool: string, signal?: AbortSignal): Promise<McpTool> {
	let found = await mcp.list(name, signal)
	let t = found.find((t) => t.name === tool)
	if (!t) throw new Error(`${name} has no tool ${tool}; it has: ${found.map((t) => t.name).join(', ') || 'none'}`)
	return t
}

// One tool's whole description and parameters.
async function describe(name: string, tool: string, signal?: AbortSignal): Promise<string> {
	let t = await mcp.find(name, tool, signal)
	let { properties = {} } = t.inputSchema ?? {}
	let params = Object.entries(properties).map(([k, p]) => `  ${k}: ${p.description ?? mcp.typeName(p)}`)
	return [mcp.signature(t), t.description?.trim(), params.length ? `Parameters:\n${params.join('\n')}` : '']
		.filter(Boolean)
		.join('\n\n')
}

// A tools/call result as Hal's tool output.
function output(result: { content?: Content[]; structuredContent?: unknown; isError?: boolean }): ToolOutput {
	let text: string[] = []
	let images: { mediaType: string; data: string }[] = []
	for (let c of result?.content ?? []) {
		if (c.type === 'text') text.push(c.text ?? '')
		else if (c.type === 'image' && c.data) images.push({ mediaType: c.mimeType ?? 'image/png', data: c.data })
		else if (c.type === 'resource' && c.resource?.text !== undefined)
			text.push(`${c.resource.uri}:\n${c.resource.text}`)
		else if (c.type === 'resource') text.push(`[resource ${c.resource?.uri} ${c.resource?.mimeType ?? ''}, binary]`)
		else if (c.type === 'resource_link') text.push(`[resource ${c.name ?? ''} ${c.uri}]`)
		else text.push(`[${c.type} ${c.mimeType ?? ''}, not shown]`)
	}
	if (!text.length && result?.structuredContent !== undefined)
		text.push(JSON.stringify(result.structuredContent, null, 2))
	return {
		text: text.join('\n') || '(no output)',
		...(images.length && { images }),
		...(result?.isError && { isError: true }),
	}
}

// Calls a tool once; a call is never retried, since it may have acted.
async function call(name: string, tool: string, args: object, signal?: AbortSignal): Promise<ToolOutput> {
	await mcp.find(name, tool, signal)
	return mcp.output(await mcp.send(name, 'tools/call', { name: tool, arguments: args }, signal))
}

// Each configured server: its state and how it runs.
function status(): string {
	let all = mcp.configs()
	let names = Object.keys(all)
	if (!names.length)
		return `No MCP servers. Add them to ${mcp.path()}: { mcpServers: { <name>: { command, args, env } | { url, headers } } }`
	return names
		.map((name) => {
			let c = all[name]!
			let s = mcp.state.servers.get(name)
			let state =
				c.enabled === false
					? 'disabled'
					: s?.peer
						? `running, ${s.tools.length} tools`
						: s?.error
							? `failed: ${s.error}`
							: 'not started'
			return `${name}: ${state}\n  ${c.url ?? [c.command, ...(c.args ?? [])].join(' ')}`
		})
		.join('\n')
}

function stop(name: string): void {
	let s = mcp.state.servers.get(name)
	mcp.state.servers.delete(name)
	if (s?.peer) mcpRpc.stop(s.peer)
	s?.starting?.then(mcpRpc.stop, () => {})
}

function stopAll(): void {
	for (let name of mcp.state.servers.keys()) mcp.stop(name)
}

export const mcp = {
	state: {
		file: undefined as { mcpServers?: Record<string, ServerConfig> } | undefined,
		servers: new Map<string, Server>(),
	},
	path,
	configs,
	expand,
	server,
	timeoutMs,
	start,
	connect,
	send,
	list,
	typeName,
	signature,
	tools,
	find,
	describe,
	output,
	call,
	status,
	stop,
	stopAll,
}
