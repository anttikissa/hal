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

export interface ToolModule<Context = unknown, Result = ToolResult> {
	definition: ToolDefinition
	argsPreview(input: unknown): string
	execute(input: unknown, context: Context, onChunk?: ToolChunkHandler): Result | Promise<Result>
}

const baseTool: Pick<ToolModule<unknown>, 'argsPreview'> = {
	argsPreview() {
		return ''
	},
}

export function defineTool<Context, Result = ToolResult, Extra extends object = {}>(
	spec: Omit<ToolModule<Context, Result>, 'argsPreview'> & { argsPreview?: ToolModule<Context, Result>['argsPreview'] } & Extra,
): ToolModule<Context, Result> & Extra {
	return Object.assign(Object.create(baseTool), spec)
}

export function previewField(field: string, fallback = ''): (input: unknown) => string {
	return (input: unknown) => {
		const value = (input as Record<string, unknown> | undefined)?.[field]
		return String(value ?? fallback)
	}
}
