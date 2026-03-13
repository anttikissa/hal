import { resolvePath, withLock } from './file-utils.ts'
import { defineTool, previewField, type ToolContext } from './tool.ts'

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

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	const inp = input as any
	const path = resolvePath(inp?.path, ctx.cwd)
	return withLock(path, async () => {
		await Bun.write(path, String(inp?.content ?? ''))
		return 'ok'
	})
}

export const write = defineTool({
	definition,
	argsPreview: previewField('path'),
	execute,
})
