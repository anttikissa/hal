// Read tool — read file contents with hashline prefixes.
//
// Returns file content as "LINE:HASH content" lines. The HASH is a
// 3-char fingerprint of each line's content. The edit tool verifies
// these hashes to prevent stale edits.

import { readFileSync, statSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { homedir } from 'os'
import { toolRegistry, type ToolContext } from './tool.ts'
import { hashline } from './hashline.ts'

const HOME = homedir()

/** Max output size — 1MB per AGENTS.md rule. */
const MAX_OUTPUT = 1_000_000

/** Resolve a path relative to cwd, handling ~ expansion. */
function resolvePath(path: string | undefined, cwd: string): string {
	if (!path?.trim()) return cwd
	if (path.startsWith('~/')) path = HOME + path.slice(1)
	return isAbsolute(path) ? path : resolve(cwd, path)
}

async function execute(input: any, ctx: ToolContext): Promise<string> {
	const path = resolvePath(input?.path, ctx.cwd)

	try {
		const stat = statSync(path)
		if (stat.isDirectory()) return `error: ${path} is a directory, not a file`
		if (stat.size > 5_000_000) return `error: file too large (${stat.size} bytes)`
	} catch (e: any) {
		return `error: ${e.message}`
	}

	let content: string
	try {
		content = readFileSync(path, 'utf-8')
	} catch (e: any) {
		return `error: ${e.message}`
	}

	// Check for binary content (null bytes in first 8KB)
	if (content.slice(0, 8192).includes('\0')) {
		return `error: ${path} appears to be a binary file`
	}

	const result = hashline.formatHashlines(content, input?.start ?? 1, input?.end)
	if (result.length > MAX_OUTPUT) {
		return result.slice(0, MAX_OUTPUT) + '\n[… truncated]'
	}
	return result
}

toolRegistry.registerTool({
	name: 'read',
	description: 'Read a file with line numbers. Use optional start/end for a line range.',
	parameters: {
		path: { type: 'string', description: 'File path (absolute or relative to cwd)' },
		start: { type: 'integer', description: 'First line number (1-based, inclusive)' },
		end: { type: 'integer', description: 'Last line number (inclusive)' },
	},
	required: ['path'],
	execute,
})

export const read = { resolvePath, execute }
