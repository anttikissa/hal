// /mcp shows each MCP server's state (task sxf); /mcp reconnect <name>
// restarts one and lists its tools.
import type { SlashCommand } from '../commands.ts'
import { mcp } from '../mcp.ts'

function names(): string[] {
	try {
		return Object.keys(mcp.configs())
	} catch {
		return []
	}
}

export const command: SlashCommand = {
	help: () =>
		`/mcp shows each MCP server: running, failed (with its error) or not started.\n/mcp reconnect <name> restarts one.\n\nServers are configured in ${mcp.path()}.`,
	complete: (args) => ['reconnect', ...names().map((n) => `reconnect ${n}`)].filter((v) => v.startsWith(args)),
	async run(args) {
		let [sub, name, ...rest] = args.trim().split(/\s+/).filter(Boolean)
		if (!sub) return { say: mcp.status() }
		if (sub !== 'reconnect' || !name || rest.length) return { error: 'usage: /mcp or /mcp reconnect <name>' }
		mcp.stop(name)
		try {
			let tools = await mcp.list(name)
			return { say: `${name}: running, ${tools.length} tools` }
		} catch (e: any) {
			return { error: e.message }
		}
	},
}
