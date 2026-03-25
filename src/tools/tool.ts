// Tool registry — defines tool interface, registration, dispatch.
//
// Every tool module registers itself on import by calling registerTool().
// The agent loop calls toToolDefs() to get provider-format definitions,
// and dispatch() to execute tool calls by name.

import type { ToolDef } from '../protocol.ts'

// ── Interfaces ──

export interface Tool {
	name: string
	description: string
	/** JSON Schema properties for tool parameters. */
	parameters: Record<string, any>
	/** Which parameters are required. */
	required?: string[]
	/** Execute the tool. Returns output string. */
	execute(input: any, context: ToolContext): Promise<string>
}

export interface ToolContext {
	sessionId: string
	cwd: string
	signal?: AbortSignal
}

// ── Registry ──

const registry = new Map<string, Tool>()

function registerTool(tool: Tool): void {
	registry.set(tool.name, tool)
}

function getTool(name: string): Tool | null {
	return registry.get(name) ?? null
}

function allTools(): Tool[] {
	return [...registry.values()]
}

/** Convert all registered tools to the provider API format (Anthropic tool_use schema). */
function toToolDefs(): ToolDef[] {
	return allTools().map(t => ({
		name: t.name,
		description: t.description,
		input_schema: {
			type: 'object',
			properties: t.parameters,
			required: t.required ?? [],
		},
	}))
}

/** Dispatch a tool call by name. Returns the tool's output string. */
async function dispatch(name: string, input: any, context: ToolContext): Promise<string> {
	const tool = getTool(name)
	if (!tool) return `error: unknown tool "${name}"`
	try {
		return await tool.execute(input, context)
	} catch (err: any) {
		return `error: ${err?.message ?? String(err)}`
	}
}

export const toolRegistry = { registerTool, getTool, allTools, toToolDefs, dispatch }
