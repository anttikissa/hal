import { resolvePath, withLock } from './file-utils.ts'
import { defineTool, previewField } from './tool.ts'

export interface WriteExecuteContext {
	cwd: string
}

const definition = {
	name: 'write',
	description: 'Create or overwrite a file with full content (no hashline prefixes).',
	input_schema: {
		type: 'object',
		properties: {
			path: { type: 'string' },
			content: { type: 'string' },
		},
		required: ['path', 'content'],
	},
}

const pathPreview = previewField('path')

async function execute(input: unknown, ctx: WriteExecuteContext): Promise<string> {
	const inp = input as any
	const path = resolvePath(inp?.path, ctx.cwd)
	return withLock(path, async () => {
		await Bun.write(path, String(inp?.content ?? ''))
		return 'ok'
	})
}

export const write = defineTool<WriteExecuteContext, string>({
	definition,
	argsPreview: pathPreview,
	execute,
})
