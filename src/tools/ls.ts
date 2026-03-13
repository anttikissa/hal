// Ls tool — list directory contents as a tree.

import { statSync, readdirSync } from 'fs'
import { defineTool, previewField } from './tool.ts'
import { resolvePath } from './file-utils.ts'
import type { ToolContext } from './tool.ts'

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage', 'target'])

function execute(input: unknown, ctx: ToolContext): string {
	const inp = input as any
	const dir = resolvePath(inp?.path, ctx.cwd)
	const maxDepth = inp?.depth ?? 3
	const lines: string[] = []

	function walk(d: string, prefix: string, depth: number) {
		if (depth > maxDepth || lines.length > 500) return
		let entries: string[]
		try { entries = readdirSync(d).sort() } catch { return }
		for (const entry of entries) {
			if (IGNORE.has(entry)) continue
			if (lines.length > 500) { lines.push(`${prefix}... (truncated)`); return }
			try {
				const full = `${d}/${entry}`
				if (statSync(full).isDirectory()) {
					lines.push(`${prefix}${entry}/`)
					walk(full, prefix + '  ', depth + 1)
				} else {
					lines.push(`${prefix}${entry}`)
				}
			} catch {}
		}
	}

	walk(dir, '', 0)
	return lines.join('\n') || '(empty directory)'
}

export const ls = defineTool({
	definition: {
		name: 'ls',
		description: 'List directory contents as a tree. Ignores node_modules, .git, dist, etc.',
		input_schema: {
			type: 'object' as const,
			properties: {
				path: { type: 'string', description: 'Directory to list (default: cwd)' },
				depth: { type: 'integer', description: 'Max depth (default: 3)' },
			},
		},
	},
	argsPreview: previewField('path', '.'),
	execute,
})
