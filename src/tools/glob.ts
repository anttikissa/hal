// Glob tool — find files by pattern.

import { $ } from 'bun'
import { defineTool, previewField } from './tool.ts'
import { resolvePath } from './file-utils.ts'
import type { ToolContext } from './tool.ts'

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	const inp = input as any
	const searchPath = resolvePath(inp?.path, ctx.cwd)
	const args = ['rg', '--files', '--hidden', '--no-ignore', '--sort=modified', '--glob', String(inp?.pattern ?? ''), searchPath]
	const result = await $`${args}`.quiet().nothrow()
	const raw = result.stdout.toString().trim()
	return raw || 'No files found.'
}

export const glob = defineTool({
	definition: {
		name: 'glob',
		description: 'Find files by glob pattern. Returns matching file paths sorted by modification time.',
		input_schema: {
			type: 'object' as const,
			properties: {
				pattern: { type: 'string', description: "Glob pattern, e.g. '*.ts', 'src/**/*.tsx'" },
				path: { type: 'string', description: 'Directory to search in (default: cwd)' },
			},
			required: ['pattern'],
		},
	},
	argsPreview: previewField('pattern'),
	execute,
})
