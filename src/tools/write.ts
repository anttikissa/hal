import { resolvePath, withLock } from './file-utils.ts'

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

function argsPreview(input: unknown): string {
	const inp = input as any
	return String(inp?.path ?? '')
}

async function execute(input: unknown, ctx: WriteExecuteContext): Promise<string> {
	const inp = input as any
	const path = resolvePath(inp?.path, ctx.cwd)
	return withLock(path, async () => {
		await Bun.write(path, String(inp?.content ?? ''))
		return 'ok'
	})
}

export const write = { definition, argsPreview, execute }
