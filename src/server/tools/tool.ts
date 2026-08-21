// Tool registry — defines tool interface, registration, dispatch.
//
// Tool modules are pure on import. They expose init() hooks, and a bootstrap
// module decides when to register them with the shared registry.

import type { ContentBlock, JsonSchemaProperties, ToolDef } from '../../common/protocol.ts'
import { helpers } from '../../utils/helpers.ts'

// ── Interfaces ──

export type ToolInput = Record<string, unknown>
export type ToolOutput = string | ContentBlock[]

export interface Tool {
	name: string
	description: string
	/** JSON Schema properties for tool parameters. */
	parameters: JsonSchemaProperties
	/** Which parameters are required. */
	required?: string[]
	execute(input: unknown, context: ToolContext): Promise<ToolOutput>
}

export interface ToolContext {
	sessionId: string
	cwd: string
	signal?: AbortSignal
	/** Called with cumulative output while a tool is executing. */
	onOutput?: (output: string) => void
	/** True after the user approved a risky model-initiated tool call. */
	approvedRisk?: boolean
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
	 * Text-output cap. Rich results have a separate absolute 1MB cap so useful
	 * images do not inherit the much smaller shell-output budget.
	 */
	maxOutputBytes: 64 * 1024,
}

const MAX_RESULT_BYTES = 1_000_000

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

/** Dispatch a tool call and enforce the text-output cap. */
async function dispatch(name: string, input: unknown, context: ToolContext): Promise<ToolOutput> {
	const tool = getTool(name)
	if (!tool) return `error: unknown tool "${name}"`
	try {
		const output = await tool.execute(input, context)
		if (typeof output === 'string') return capOutput(output)
		if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_RESULT_BYTES) return 'error: tool result exceeds the 1MB limit'
		const text = outputText(output)
		return Buffer.byteLength(text, 'utf8') > config.maxOutputBytes ? capOutput(text) : output
	} catch (err: unknown) {
		return `error: ${errorMessage(err)}`
	}
}

function outputText(output: ToolOutput): string {
	if (typeof output === 'string') return output
	const text = output.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
	return text || '[image]'
}

export const toolRegistry = { config, registerTool, getTool, allTools, toToolDefs, dispatch, outputText, clearForTests, inputObject, errorMessage }
