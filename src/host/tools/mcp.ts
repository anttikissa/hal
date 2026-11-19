// MCP: calls tools of the Model Context Protocol servers in mcp.ason
// (task sxf), behind the native tool like every Hal tool.

import { callText } from '../../common/call-text.ts'
import { mcp } from '../mcp.ts'
import type { Tool, ToolOutput } from '../tools.ts'

const usage = 'MCP [ "<server>" | "<server>.<tool>" [ { <arguments> } ] ]'

export const tool: Tool<ToolOutput> = {
	name: 'mcp',
	syntax: {
		summary: 'call MCP server tools; MCP lists servers',
		usage: [
			'MCP                                   // configured servers',
			'MCP "<server>"                        // its tools',
			'MCP "<server>.<tool>"                 // one tool in full',
			'MCP "<server>.<tool>" { <arguments> } // calls it; {} for none',
		],
		resolve(raw) {
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
	},
	description: 'List and call the tools of configured MCP servers.',
	parameters: {
		type: 'object',
		properties: {
			target: { type: 'string', description: '<server> or <server>.<tool>' },
			arguments: { type: 'object', description: 'The tool arguments; calls the tool' },
		},
	},
	async run(input, ctx) {
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
	},
}
