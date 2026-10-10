// Action (task 3fv): the one native tool providers see. Its input is
// { action: string } in the grammar of common/action.ts; this module
// maps it onto the internal tools in src/host/tools/, whose modules own
// their Action metadata (Tool.action). History keeps the resolved call
// with the original text, which replay sends back verbatim; the native
// Action call itself never runs: resolution happens as the call arrives
// (turns.ts) and a call that fails to resolve becomes an error result.

import { toolPresentations } from './tool-presentation.ts'
import { action } from '../common/action.ts'
import type { ToolCallBlock } from '../common/blocks.ts'
import type { ToolDef } from './provider.ts'
import { type Tool, tools } from './tools.ts'

const name = 'Action'

type Schema = { properties?: Record<string, { type?: string; description?: string; items?: { type?: string } }>; required?: string[] }
const schema = (tool: Tool<unknown>) => tool.parameters as Schema

function def(): ToolDef {
	return {
		name,
		description: 'Perform one action, NAME followed by its arguments, e.g. READ "src/main.ts:1-80" or BASH "ls -l". The system prompt lists the actions; HELP <NAME> gives the exact syntax of one. Make independent calls in parallel.',
		inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'One action, e.g. READ "src/main.ts"' } }, required: ['action'], additionalProperties: false },
	}
}

function find(id: string): Tool<unknown> {
	let tool = tools.all().get(id)
	if (!tool) throw new Error(`unknown action ${id.toUpperCase()}; available: ${[...tools.all().keys()].map((n) => n.toUpperCase()).join(', ')}. HELP lists them; shell commands go in BASH "..."`)
	return tool
}

// Positional strings fill the tool's positional fields in order; an
// object argument supplies fields by name. The purpose becomes the
// description where the tool has one.
function generic(tool: Tool<unknown>, raw: string): Record<string, unknown> {
	let { values, purpose, unclosed } = action.values(raw)
	let { properties = {}, required = [] } = schema(tool)
	let positional = tool.action?.positional ?? required
	let input: Record<string, unknown> = {}
	let next = 0
	let usage = () => `Usage: ${actions.usage(tool).join(' | ')}`
	for (let value of values) {
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			for (let [key, v] of Object.entries(value)) {
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

// The internal call an Action text stands for. Throws with what is wrong.
function resolve(text: unknown): { name: string; input: Record<string, unknown> } {
	let parsed = action.parse(text)
	let tool = actions.find(parsed.name)
	if (tool.action?.resolve) return tool.action.resolve(parsed.raw)
	return { name: tool.name, input: actions.generic(tool, parsed.raw) }
}

// A provider's native Action call as history keeps it: the internal call
// plus the text, or unchanged when it does not resolve (tools.run then
// reports why).
function arrived(call: ToolCallBlock): ToolCallBlock {
	if (call.name === name && call.action === undefined) try {
		let { name: tool, input } = actions.resolve(call.input.action)
		call = { type: 'tool_call', id: call.id, name: tool, input, action: call.input.action as string }
	} catch {}
	return toolPresentations.attach(call, call)
}

// Exact syntax lines, from the module or its schema.
function usage(tool: Tool<unknown>): string[] {
	if (tool.action?.usage) return tool.action.usage
	let { properties = {}, required = [] } = schema(tool)
	let positional = tool.action?.positional ?? required
	let rest = Object.keys(properties).filter((k) => !positional.includes(k))
	let args = positional.map((k) => (required.includes(k) ? `"<${k}>"` : `["<${k}>"]`))
	if (rest.length) args.push(`[{ ${rest.join(', ')} }]`)
	return [[tool.name.toUpperCase(), ...args].join(' ')]
}

// HELP for one tool: description, syntax, every field.
function help(tool: Tool<unknown>): string {
	let { properties = {}, required = [] } = schema(tool)
	let fields = Object.entries(properties).map(([key, p]) => {
		let type = p.type === 'array' ? `${p.items?.type ?? 'value'} list` : p.type ?? 'value'
		let text = tool.action?.fields?.[key] ?? p.description
		return `  ${key} (${type}${required.includes(key) ? ', required' : ''})${text ? `: ${text}` : ''}`
	})
	return [`${tool.name.toUpperCase()}: ${tool.description}`, '', 'Usage:', ...actions.usage(tool).map((u) => `  ${u}`), ...(fields.length ? ['', 'Fields:', ...fields] : [])].join('\n')
}

// One line per tool the system prompt does not explain, for $tools_summary,
// except the tools named in `omit`.
function summary(omit: string[] = []): string {
	return [...tools.all().values()].filter((t) => t.action?.summary !== false && !omit.includes(t.name)).map((t) => `\t${t.name.toUpperCase()}${t.action?.summary ? ` ${t.action.summary}` : ''}`).join('\n')
}

export const actions = { name, def, find, generic, resolve, arrived, usage, help, summary }
