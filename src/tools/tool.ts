export interface ToolDefinition {
	name: string
	description?: string
	input_schema?: {
		type: string
		properties: Record<string, unknown>
		required?: string[]
		[key: string]: unknown
	}
	[key: string]: unknown
}

export type ToolResult = string | any[]

export type ToolChunkHandler = (text: string) => Promise<void>

export interface ToolContext {
	cwd: string
	sessionId?: string
	signal?: AbortSignal
	env?: Record<string, string | undefined>
	contextLines?: number
	truncate?: (text: string) => string
	evalCtx?: unknown
}

export interface ToolModule {
	definition: ToolDefinition
	argsPreview(input: unknown): string
	execute(input: unknown, ctx: ToolContext, onChunk?: ToolChunkHandler): ToolResult | Promise<ToolResult>
}

const baseTool: Pick<ToolModule, 'argsPreview'> = {
	argsPreview() {
		return ''
	},
}

export function defineTool<Extra extends object = {}>(
	spec: Omit<ToolModule, 'argsPreview'> & { argsPreview?: ToolModule['argsPreview'] } & Extra,
): ToolModule & Extra {
	return Object.assign(Object.create(baseTool), spec)
}

export function previewField(field: string, fallback = ''): (input: unknown) => string {
	return (input: unknown) => {
		const value = (input as Record<string, unknown> | undefined)?.[field]
		return String(value ?? fallback)
	}
}
