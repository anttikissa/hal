import { $ } from 'bun'
import { resolvePath } from './file-utils.ts'
import { defineTool, previewField } from './tool.ts'

interface GrepInput {
	pattern?: string
	path?: string
	include?: string
}

export interface GrepExecuteContext {
	cwd: string
}

const definition = {
	name: 'grep',
	description: 'Search file contents using ripgrep. Returns matching lines with file paths and line numbers.',
	input_schema: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: 'Search pattern (regex)' },
			path: { type: 'string', description: 'Directory or file to search (default: cwd)' },
			include: { type: 'string', description: "Glob pattern to filter files, e.g. '*.ts'" },
		},
		required: ['pattern'],
	},
}

const patternPreview = previewField('pattern')

async function execute(input: unknown, context: GrepExecuteContext): Promise<string> {
	const inp = input as GrepInput
	const pattern = patternPreview(inp)
	const searchPath = resolvePath(inp?.path, context.cwd)
	const args = ['rg', '-nH', '--no-heading', '--color=never', '--hidden', '--no-ignore', '--max-count=100', '--sort=modified']
	if (inp?.include) args.push('--glob', String(inp.include))
	args.push('--', pattern, searchPath)
	const result = await $`${args}`.quiet().nothrow()
	const raw = result.stdout.toString().trim()
	if (!raw) return 'No matches found.'
	return raw
}

export const grep = defineTool<GrepExecuteContext, string>({
	definition,
	argsPreview: patternPreview,
	execute,
})
