// Glob tool — find files by glob pattern.
//
// Uses ripgrep's --files mode with --glob for fast, gitignore-aware
// file discovery sorted by modification time.

import { toolRegistry, type ToolContext } from './tool.ts'
import { read } from './read.ts'

async function execute(input: any, ctx: ToolContext): Promise<string> {
	const pattern = String(input?.pattern ?? '')
	if (!pattern) return 'error: pattern is required'

	const searchPaths = read.resolvePaths(input?.path, ctx.cwd)

	const args = ['rg', '--files', '--hidden', '--no-ignore', '--sort=modified', '--glob', pattern, ...searchPaths]

	const proc = Bun.spawn(args, {
		stdout: 'pipe',
		stderr: 'pipe',
		cwd: ctx.cwd,
	})

	const stdout = await new Response(proc.stdout).text()
	await proc.exited

	const result = stdout.trim()
	if (!result) return 'No files found.'
	// Truncate if over 1MB
	if (result.length > 1_000_000) {
		return result.slice(0, 1_000_000) + '\n[… truncated]'
	}
	return result
}

const globTool = {
	name: 'glob',
	description: 'Find files by glob pattern. Returns matching file paths sorted by modification time.',
	parameters: {
		pattern: { type: 'string', description: "Glob pattern, e.g. '*.ts', 'src/**/*.tsx'" },
		path: { type: 'string', description: 'Directory to search in (default: cwd). Space-separated paths ok.' },
	},
	required: ['pattern'],
	execute,
}

function init(): void {
	toolRegistry.registerTool(globTool)
}

export const glob = { execute, init }
