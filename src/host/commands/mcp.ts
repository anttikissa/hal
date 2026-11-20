// /mcp shows each MCP server's state (task sxf); /mcp reconnect <name>
// restarts one and lists its tools; /mcp login <name> signs in to an
// HTTP server with OAuth.
import type { SlashCommand } from '../commands.ts'
import { mcp } from '../mcp.ts'
import { mcpOauth } from '../mcp-oauth.ts'

function names(): string[] {
	try {
		return Object.keys(mcp.configs())
	} catch {
		return []
	}
}

export const command: SlashCommand = {
	help: () =>
		`/mcp shows each MCP server: running, failed (with its error) or not started.\n/mcp reconnect <name> restarts one.\n/mcp login <name> signs in to an HTTP server that uses OAuth, in a browser on this computer.\n\nServers are configured in ${mcp.path()}.`,
	complete: (args) =>
		['reconnect', 'login', ...names().flatMap((n) => [`reconnect ${n}`, `login ${n}`])].filter((v) =>
			v.startsWith(args),
		),
	async run(args, _answers, ctx) {
		let [sub, name, ...rest] = args.trim().split(/\s+/).filter(Boolean)
		if (!sub) return { say: mcp.status() }
		if ((sub !== 'reconnect' && sub !== 'login') || !name || rest.length)
			return { error: 'usage: /mcp, /mcp reconnect <name> or /mcp login <name>' }
		try {
			if (sub === 'login') {
				let { config } = mcp.server(name)
				if (!config.url) return { error: `${name} runs locally (command); only HTTP servers use OAuth` }
				await mcpOauth.login(name, config.url, ctx.say)
			}
			mcp.stop(name)
			let tools = await mcp.list(name)
			return { say: `${name}: running, ${tools.length} tools` }
		} catch (e: any) {
			return { error: e.message }
		}
	},
}
