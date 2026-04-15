// Glob tool — find files by glob pattern.
//
// Uses ripgrep's --files mode with --glob for fast, gitignore-aware
// file discovery sorted by modification time.

import { toolRegistry, type ToolContext } from './tool.ts'
import { read } from './read.ts'

const MAX_OUTPUT_BYTES = 20_000
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
	return truncateUtf8(result, MAX_OUTPUT_BYTES)
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
