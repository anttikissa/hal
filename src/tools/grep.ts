// Grep tool — search file contents using ripgrep.
//
// Shells out to `rg` with sensible defaults. Returns matching lines
// with file paths and line numbers.

import { toolRegistry, type ToolContext } from './tool.ts'
import { read } from './read.ts'

const MAX_OUTPUT_BYTES = 40_000
const TRUNCATED_SUFFIX = '\n[… truncated]'

function truncateUtf8(text: string, limit: number): string {
	if (Buffer.byteLength(text, 'utf8') <= limit) return text
	const budget = limit - Buffer.byteLength(TRUNCATED_SUFFIX, 'utf8')
	if (budget <= 0) return TRUNCATED_SUFFIX.slice(0, limit)
	let lo = 0
	let hi = text.length
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2)
		if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= budget) lo = mid
		else hi = mid - 1
	}
	return text.slice(0, lo) + TRUNCATED_SUFFIX
}

async function execute(input: any, ctx: ToolContext): Promise<string> {
	const pattern = String(input?.pattern ?? '')
	if (!pattern) return 'error: pattern is required'

	const searchPaths = read.resolvePaths(input?.path, ctx.cwd)
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
	args.push('--', pattern, ...searchPaths)

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
		const err = stderr.trim()
		if (err && proc.exitCode !== 1) {
			// Clean up verbose rg errors like "IO error for operation on /path: No such file or directory (os error 2)"
			const notFound = err.match(/rg:\s*(.+?):\s*(?:IO error|No such file)/i)
			if (notFound) return `Error: file not found: ${notFound[1]}`
			return `error: ${err}`
		}
		return 'No matches found.'
	}
	return truncateUtf8(result, MAX_OUTPUT_BYTES)
}

const grepTool = {
	name: 'grep',
	description: 'Search file contents using ripgrep. Returns matching lines with file paths and line numbers.',
	parameters: {
		pattern: { type: 'string', description: 'Search pattern (regex)' },
		path: { type: 'string', description: 'Directory or file to search (default: cwd). Space-separated paths ok.' },
		include: { type: 'string', description: "Glob pattern to filter files, e.g. '*.ts'" },
		maxResults: { type: 'integer', description: 'Max matches per file (default: 100)' },
	},
	required: ['pattern'],
	execute,
}

function init(): void {
	toolRegistry.registerTool(grepTool)
}

export const grep = { execute, init }
