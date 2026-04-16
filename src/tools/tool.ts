// Tool registry — defines tool interface, registration, dispatch.
//
// Tool modules are pure on import. They expose init() hooks, and a bootstrap
// module decides when to register them with the shared registry.

import type { JsonSchemaProperties, ToolDef } from '../protocol.ts'

// ── Interfaces ──

export type ToolInput = Record<string, unknown>

export interface Tool {
	name: string
	description: string
	/** JSON Schema properties for tool parameters. */
	parameters: JsonSchemaProperties
	/** Which parameters are required. */
	required?: string[]
	/** Execute the tool. Returns output string. */
	execute(input: unknown, context: ToolContext): Promise<string>
}

export interface ToolContext {
	sessionId: string
	cwd: string
	signal?: AbortSignal
}

function inputObject(input: unknown): ToolInput {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
	return input as ToolInput
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
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

function clearForTests(): void {
	registry.clear()
}

/** Convert all registered tools to the provider API format (Anthropic tool_use schema). */
function toToolDefs(): ToolDef[] {
	return allTools().map((t) => ({
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
async function dispatch(name: string, input: unknown, context: ToolContext): Promise<string> {
	const tool = getTool(name)
	if (!tool) return `error: unknown tool "${name}"`
	try {
		return await tool.execute(input, context)
	} catch (err: unknown) {
		return `error: ${errorMessage(err)}`
	}
}

export const toolRegistry = { registerTool, getTool, allTools, toToolDefs, dispatch, clearForTests, inputObject, errorMessage }
