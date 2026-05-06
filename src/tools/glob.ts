// Glob tool — find files by glob pattern.
//
// Uses ripgrep's --files mode with --glob for fast, gitignore-aware
// file discovery sorted by modification time.

import { toolRegistry, type ToolContext } from './tool.ts'
import { read } from './read.ts'
import { processOutput } from '../utils/process-output.ts'

const MAX_OUTPUT_BYTES = 20_000
const TRUNCATED_SUFFIX = '\n[… truncated]'

function kill(proc: { pid: number }): void {
	try {
		process.kill(proc.pid, 'SIGTERM')
	} catch {}
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

	const stdoutPromise = processOutput.readLimited(proc.stdout, MAX_OUTPUT_BYTES, TRUNCATED_SUFFIX, () => kill(proc))
	const stderrPromise = processOutput.readLimited(proc.stderr, MAX_OUTPUT_BYTES, TRUNCATED_SUFFIX)
	const [stdout] = await Promise.all([stdoutPromise, stderrPromise])
	await proc.exited

	const result = stdout.text.trim()
	if (!result) return 'No files found.'
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
