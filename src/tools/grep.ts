// Grep tool — search file contents using ripgrep.
//
// Shells out to `rg` with sensible defaults. Returns matching lines
// with file paths and line numbers.

import { toolRegistry, type ToolContext } from './tool.ts'
import { read } from './read.ts'

async function execute(input: any, ctx: ToolContext): Promise<string> {
	const pattern = String(input?.pattern ?? '')
	if (!pattern) return 'error: pattern is required'

	const searchPath = read.resolvePath(input?.path, ctx.cwd)
	const maxResults = input?.maxResults ?? 100

	const args = [
		'rg',
		'-nH',
		'--no-heading',
		'--color=never',
		'--hidden',
		'--no-ignore',
		`--max-count=${maxResults}`,
		'--sort=modified',
	]
	if (input?.include) args.push('--glob', String(input.include))
	args.push('--', pattern, searchPath)

	const proc = Bun.spawn(args, {
		stdout: 'pipe',
		stderr: 'pipe',
		cwd: ctx.cwd,
	})

	const stdout = await new Response(proc.stdout).text()
	const stderr = await new Response(proc.stderr).text()
	await proc.exited

	const result = stdout.trim()
	if (!result) {
		// rg returns exit 1 for "no matches" — not an error
		if (stderr.trim() && proc.exitCode !== 1) return `error: ${stderr.trim()}`
		return 'No matches found.'
	}
	// Truncate if over 1MB
	if (result.length > 1_000_000) {
		return result.slice(0, 1_000_000) + '\n[… truncated]'
	}
	return result
}

toolRegistry.registerTool({
	name: 'grep',
	description: 'Search file contents using ripgrep. Returns matching lines with file paths and line numbers.',
	parameters: {
		pattern: { type: 'string', description: 'Search pattern (regex)' },
		path: { type: 'string', description: 'Directory or file to search (default: cwd)' },
		include: { type: 'string', description: "Glob pattern to filter files, e.g. '*.ts'" },
		maxResults: { type: 'integer', description: 'Max matches per file (default: 100)' },
	},
	required: ['pattern'],
	execute,
})

export const grep = { execute }
