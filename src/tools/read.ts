import { statSync } from 'fs'
import { formatHashlines, resolvePath } from './file-utils.ts'
import { defineTool, previewField, type ToolContext } from './tool.ts'
import { readFiles } from '../utils/read-file.ts'

const definition = {
	name: 'read',
	description: 'Read a file with hashline prefixes (LINE:HASH content). Use optional start/end to read a line range.',
	input_schema: {
		type: 'object',
		properties: {
			path: { type: 'string' },
			start: { description: 'First line number (1-based, inclusive)', type: 'integer' },
			end: { description: 'Last line number (inclusive)', type: 'integer' },
		},
		required: ['path'],
	},
}

function execute(input: unknown, ctx: ToolContext): string {
	const inp = input as any
	const path = resolvePath(inp?.path, ctx.cwd)
	try {
		const stat = statSync(path)
		if (stat.isDirectory()) return `error: ${path} is a directory, use ls`
	} catch (e: any) {
		return `error: ${e.message}`
	}
	const content = readFiles.readTextSync(path, 'tool.read')
	return formatHashlines(content, inp?.start, inp?.end)
}

export const read = defineTool({
	definition,
	argsPreview: previewField('path'),
	execute,
})
