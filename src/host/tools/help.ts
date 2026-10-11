// help: exact call syntax, collected from the tool modules themselves
// (nativeTool.help), never from a separate list (task 3fv).

import { nativeTool } from '../native-tool.ts'
import { type Tool, tools } from '../tools.ts'

export const tool: Tool = {
	name: 'help',
	syntax: { summary: false, positional: ['name'], usage: ['HELP', 'HELP <NAME>'] },
	description: 'Explain a tool: its syntax, fields, defaults and units. Without a name, list every tool with its syntax.',
	parameters: { type: 'object', properties: { name: { type: 'string', description: 'A tool name, e.g. EDIT' } } },
	readOnly: true,
	async run(input) {
		if (input.name !== undefined && typeof input.name !== 'string') throw new Error('name must be a tool name, e.g. HELP EDIT')
		if (input.name) return nativeTool.help(nativeTool.find(input.name.toLowerCase()))
		let lines = [...tools.all().values()].flatMap((t) => nativeTool.usage(t))
		return [
			'One tool per call; make independent calls in parallel. Names are case-insensitive.',
			'Arguments are JS string literals, { objects } or [ arrays ] (never evaluated), or bare words on the call line.',
			'HELP <NAME> explains one tool.',
			'',
			...lines,
		].join('\n')
	},
}
