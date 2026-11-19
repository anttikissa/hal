// MCP: calls tools of the Model Context Protocol servers in mcp.ason
// (task sxf), behind the native tool like every Hal tool.

import { callText } from '../../common/call-text.ts'
import { mcp } from '../mcp.ts'
import type { Tool, ToolContext, ToolOutput } from '../tools.ts'

// Configuration: true puts the whole help in the system prompt; false
// lists only the summary under Other tools (HELP <TOOL> shows the rest).
const inPrompt = false
const summary = 'call MCP server tools; MCP lists servers'
const help = `## MCP

List and call the tools of configured MCP servers.
MCP                                   // configured servers
MCP "<server>"                        // its tools
MCP "<server>.<tool>"                 // one tool in full
MCP "<server>.<tool>" { <arguments> } // calls it; {} for none`

const parameters = {
	type: 'object',
	properties: { target: { type: 'string' }, arguments: { type: 'object' } },
}

const usage = 'MCP [ "<server>" | "<server>.<tool>" [ { <arguments> } ] ]'

const syntax = {
	usage: help.split('\n').slice(3),
	resolve(raw: string) {
		let { values } = callText.values(raw)
		let [target, args, ...rest] = values
		let object = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v)
		if (
			rest.length ||
			(target !== undefined && (typeof target !== 'string' || !target)) ||
			(args !== undefined && !object(args))
		)
			throw new Error(`Usage: ${usage}`)
		return {
			name: 'mcp',
			input: { ...(target !== undefined && { target }), ...(args !== undefined && { arguments: args }) },
		}
	},
}

async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	let { target, arguments: args } = input
	if (target === undefined) return mcp.status()
	if (typeof target !== 'string' || !target) throw new Error('target must be <server> or <server>.<tool>')
	let dot = target.indexOf('.')
	if (dot < 0) {
		if (args !== undefined) throw new Error(`name the tool: MCP "${target}.<tool>" { <arguments> }`)
		return mcp.tools(target, ctx.signal)
	}
	let [server, name] = [target.slice(0, dot), target.slice(dot + 1)]
	if (args === undefined) return mcp.describe(server, name, ctx.signal)
	if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
	return mcp.call(server, name, args, ctx.signal)
}

export const tool: Tool<ToolOutput> = { name: 'mcp', inPrompt, summary, help, parameters, syntax, run }
