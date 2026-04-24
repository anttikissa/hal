// Tool registry — defines tool interface, registration, dispatch.
//
// Tool modules are pure on import. They expose init() hooks, and a bootstrap
// module decides when to register them with the shared registry.

import type { JsonSchemaProperties, ToolDef } from '../protocol.ts'
import { helpers } from '../utils/helpers.ts'

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
const config = {
	/**
	 * Hard cap for any tool result that is sent back to the model.
	 *
	 * Individual tools may impose smaller limits for efficiency, but this final
	 * registry-level guard prevents one forgotten tool or shell pipeline from
	 * stuffing megabytes into the next provider request.
	 */
	maxOutputBytes: 64 * 1024,
}

function capOutput(text: string): string {
	const bytes = Buffer.byteLength(text, 'utf8')
	if (bytes <= config.maxOutputBytes) return text

	const overBy = bytes - config.maxOutputBytes
	const suffix = [
		'',
		'',
		`[tool result truncated: output exceeded the ${config.maxOutputBytes} byte cap by ${overBy} bytes.`,
		'Narrow the command/query, redirect large output to a file and inspect slices with read/grep,',
		'or use eval to temporarily adjust toolRegistry.config.maxOutputBytes if you truly need more.]',
	].join('\n')
	return helpers.truncateUtf8(text, config.maxOutputBytes, suffix)
}

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
		return capOutput(await tool.execute(input, context))
	} catch (err: unknown) {
		return `error: ${errorMessage(err)}`
	}
}

export const toolRegistry = { config, registerTool, getTool, allTools, toToolDefs, dispatch, clearForTests, inputObject, errorMessage }
