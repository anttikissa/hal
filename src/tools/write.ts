// Write + Edit tools — file creation and surgical editing.
//
// Write: create or overwrite a file with full content.
// Edit: exact string replacement — find oldString, replace with newString.
// Both create parent directories as needed.

import { readFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { toolRegistry, type ToolContext } from './tool.ts'
import { read } from './read.ts'

// ── Shared helpers ──

/** Ensure parent directory exists before writing. */
function ensureParent(path: string): void {
	const dir = dirname(path)
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// Simple per-path lock to prevent concurrent writes to the same file.
const locks = new Map<string, Promise<void>>()

async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(path) ?? Promise.resolve()
	const result = prev.then(fn, fn)
	const done = result.then(() => {}, () => {})
	locks.set(path, done)
	done.then(() => {
		if (locks.get(path) === done) locks.delete(path)
	})
	return result
}

// ── Write tool ──

async function executeWrite(input: any, ctx: ToolContext): Promise<string> {
	const path = read.resolvePath(input?.path, ctx.cwd)
	const content = String(input?.content ?? '')

	return withLock(path, async () => {
		ensureParent(path)
		await Bun.write(path, content)

		const lines = content.split('\n')
		// Show first few lines as confirmation
		const preview = lines.slice(0, 5).join('\n')
		if (lines.length <= 5) return `Wrote ${path} (${lines.length} lines)\n${preview}`
		return `Wrote ${path} (${lines.length} lines)\n${preview}\n[+ ${lines.length - 5} more lines]`
	})
}

toolRegistry.registerTool({
	name: 'write',
	description: 'Create or overwrite a file with the given content.',
	parameters: {
		path: { type: 'string', description: 'File path (absolute or relative to cwd)' },
		content: { type: 'string', description: 'Full file content' },
	},
	required: ['path', 'content'],
	execute: executeWrite,
})

// ── Edit tool ──

async function executeEdit(input: any, ctx: ToolContext): Promise<string> {
	const path = read.resolvePath(input?.path, ctx.cwd)
	const oldString = String(input?.old_string ?? '')
	const newString = String(input?.new_string ?? '')

	if (!oldString) return 'error: old_string is required'
	if (oldString === newString) return 'error: old_string and new_string are identical'

	return withLock(path, async () => {
		let content: string
		try {
			content = readFileSync(path, 'utf-8')
		} catch {
			return `error: file not found: ${path}`
		}

		// Count occurrences to detect ambiguous edits
		const count = content.split(oldString).length - 1
		if (count === 0) return `error: old_string not found in ${path}`
		if (count > 1) return `error: old_string found ${count} times in ${path} (must be unique)`

		// Apply the replacement
		const updated = content.replace(oldString, newString)
		ensureParent(path)
		await Bun.write(path, updated)

		// Build a diff-style confirmation showing context around the change
		const idx = content.indexOf(oldString)
		const before = content.slice(0, idx)
		const lineNum = before.split('\n').length
		const oldLines = oldString.split('\n')
		const newLines = newString.split('\n')

		let diff = `Edited ${path} at line ${lineNum}\n`
		for (const line of oldLines) diff += `- ${line}\n`
		for (const line of newLines) diff += `+ ${line}\n`
		return diff.trimEnd()
	})
}

toolRegistry.registerTool({
	name: 'edit',
	description: 'Surgical string replacement in a file. Finds the exact old_string and replaces it with new_string. old_string must appear exactly once in the file.',
	parameters: {
		path: { type: 'string', description: 'File path (absolute or relative to cwd)' },
		old_string: { type: 'string', description: 'Exact text to find (must be unique in file)' },
		new_string: { type: 'string', description: 'Replacement text' },
	},
	required: ['path', 'old_string', 'new_string'],
	execute: executeEdit,
})

export const write = { executeWrite, executeEdit }
