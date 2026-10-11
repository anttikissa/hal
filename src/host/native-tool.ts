// The one native tool providers see (task 3fv): `tool`, whose input is
// { cmd: string } in the grammar of common/call-text.ts; this module
// maps it onto the tools in src/host/tools/, whose modules own their
// call syntax (Tool.syntax). History keeps the resolved call with the
// original text, which replay sends back verbatim; the native call
// itself never runs: resolution happens as the call arrives (turns.ts)
// and a call that fails to resolve becomes an error result.

import { toolPresentations } from './tool-presentation.ts'
import { callText } from '../common/call-text.ts'
import type { ToolCallBlock } from '../common/blocks.ts'
import type { ToolDef } from './provider.ts'
import { type CallContext, type Tool, tools } from './tools.ts'

const name = 'tool'

type Schema = { properties?: Record<string, { type?: string; description?: string; items?: { type?: string } }>; required?: string[] }
const schema = (tool: Tool<unknown>) => tool.parameters as Schema

function def(): ToolDef {
	return {
		name,
		description: 'Call one tool. Make independent calls in parallel.',
		inputSchema: { type: 'object', properties: { cmd: { type: 'string', description: 'TOOL followed by its arguments, e.g. READ "src/main.ts:1-80" or BASH "ls -l". HELP <TOOL> gives the exact syntax of one.' } }, required: ['cmd'], additionalProperties: false },
	}
}

function find(id: string): Tool<unknown> {
	let tool = tools.all().get(id)
	if (!tool) throw new Error(`unknown tool ${id.toUpperCase()}; available: ${[...tools.all().keys()].map((n) => n.toUpperCase()).join(', ')}. HELP lists them; shell commands go in BASH "..."`)
	return tool
}

// Positional strings fill the tool's positional fields in order; an
// object argument supplies fields by name. Every tool takes an optional
// purpose, as a comment or a description field; it becomes the description
// where the tool has one and is dropped elsewhere.
function generic(tool: Tool<unknown>, raw: string): Record<string, unknown> {
	let { values, purpose, unclosed } = callText.values(raw)
	let { properties = {}, required = [] } = schema(tool)
	let positional = tool.syntax?.positional ?? required
	let input: Record<string, unknown> = {}
	let next = 0
	let usage = () => `Usage: ${nativeTool.usage(tool).join(' | ')}`
	for (let value of values) {
		// [{ … }] stands for { … }.
		if (Array.isArray(value) && value.length === 1 && value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])) value = value[0]
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			for (let [field, v] of Object.entries(value)) {
				let alias = tool.syntax?.aliases?.[field]
				if (alias === null || (field === 'description' && !Object.hasOwn(properties, field))) continue
				let key = alias !== undefined && !Object.hasOwn(properties, field) ? alias : field
				if (!Object.hasOwn(properties, key)) throw new Error(`${tool.name.toUpperCase()} has no field '${key}'. ${usage()}`)
				if (Object.hasOwn(input, key)) throw new Error(`${tool.name.toUpperCase()} got '${key}' twice. ${usage()}`)
				input[key] = v
			}
			continue
		}
		let key = positional[next++]
		if (key === undefined) throw new Error(`${tool.name.toUpperCase()} takes ${positional.length} plain argument${positional.length === 1 ? '' : 's'}, got another: ${JSON.stringify(value)}. ${usage()}`)
		if (Object.hasOwn(input, key)) throw new Error(`${tool.name.toUpperCase()} got '${key}' twice. ${usage()}`)
		input[key] = value
	}
	if (purpose && Object.hasOwn(properties, 'description') && input.description === undefined) input.description = purpose
	let missing = required.filter((k) => input[k] === undefined)
	if (missing.length) throw new Error(`${tool.name.toUpperCase()} is missing ${missing.join(', ')}${unclosed ? ' (an unclosed /* comment ran to its line end; close it with */)' : ''}. ${usage()}`)
	return input
}

// The internal call a call text stands for. Throws with what is wrong.
// `ctx`: the session it serves, when known (task pf2).
function resolve(text: unknown, ctx?: CallContext): { name: string; input: Record<string, unknown> } {
	let parsed = callText.parse(text)
	let tool = nativeTool.find(parsed.name)
	if (tool.syntax?.resolve) return tool.syntax.resolve(parsed.raw, ctx)
	return { name: tool.name, input: nativeTool.generic(tool, parsed.raw) }
}

// A provider's native call as history keeps it: the internal call plus
// the text, or unchanged when it does not resolve (tools.run then
// reports why).
function arrived(call: ToolCallBlock, ctx?: CallContext): ToolCallBlock {
	if (call.name === name && call.cmd === undefined) try {
		let { name: tool, input } = nativeTool.resolve(call.input.cmd, ctx)
		call = { type: 'tool_call', id: call.id, name: tool, input, cmd: call.input.cmd as string }
	} catch {}
	return toolPresentations.attach(call, call)
}

// Exact syntax lines, from the module or its schema.
function usage(tool: Tool<unknown>): string[] {
	if (tool.syntax?.usage) return tool.syntax.usage
	let { properties = {}, required = [] } = schema(tool)
	let positional = tool.syntax?.positional ?? required
	let rest = Object.keys(properties).filter((k) => !positional.includes(k) && k !== 'description')
	let args = positional.map((k) => (required.includes(k) ? `"<${k}>"` : `["<${k}>"]`))
	if (rest.length) args.push(`[{ ${rest.join(', ')} }]`)
	return [[tool.name.toUpperCase(), ...args].join(' ')]
}

// HELP for one tool: description, syntax, every field.
function help(tool: Tool<unknown>): string {
	let { properties = {}, required = [] } = schema(tool)
	let fields = Object.entries(properties).map(([key, p]) => {
		let type = p.type === 'array' ? `${p.items?.type ?? 'value'} list` : p.type ?? 'value'
		let text = tool.syntax?.fields?.[key] ?? p.description
		return `  ${key} (${type}${required.includes(key) ? ', required' : ''})${text ? `: ${text}` : ''}`
	})
	return [`${tool.name.toUpperCase()}: ${tool.description}`, '', 'Usage:', ...nativeTool.usage(tool).map((u) => `  ${u}`), ...(fields.length ? ['', 'Fields:', ...fields] : [])].join('\n')
}

// One line per tool the system prompt does not explain, for $tools_summary.
function summary(): string {
	return [...tools.all().values()].filter((t) => t.syntax?.summary !== false).map((t) => `\t${t.name.toUpperCase()}${t.syntax?.summary ? ` ${t.syntax.summary}` : ''}`).join('\n')
}

export const nativeTool = { name, def, find, generic, resolve, arrived, usage, help, summary }
