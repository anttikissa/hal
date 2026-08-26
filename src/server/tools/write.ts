// Write + Edit tools — file creation and surgical editing.
//
// Write: create or overwrite a file with full content.
// Edit: replace or insert using hashline refs from the read tool.
//   Hashes are verified before applying. When line numbers merely shifted after
//   earlier edits in the same session, we can remap them in memory.

import { readFileSync } from 'fs'
import { dirname, extname, resolve } from 'path'
import { ensureDir } from '../state.ts'
import { helpers } from '../../utils/helpers.ts'
import { toolRegistry, type ToolContext } from './tool.ts'
import { editRemap } from './edit-remap.ts'
import { hashline } from './hashline.ts'
import { read } from './read.ts'
import { sensitive } from './sensitive.ts'

// ── Shared helpers ──

const MAX_OUTPUT_BYTES = 1_000_000
const TRUNCATED_SUFFIX = '\n[… truncated]'
const REPO_ROOT = resolve(import.meta.dir, '../../..')
const TSC_FILE_SCRIPT = resolve(REPO_ROOT, 'scripts/tsc-file.ts')
const OXLINT_FILE_SCRIPT = resolve(REPO_ROOT, 'scripts/oxlint-file.ts')

function ensureParent(path: string): void {
	ensureDir(dirname(path))
}

// Simple per-path lock to prevent concurrent writes to the same file.
const locks = new Map<string, Promise<void>>()

function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(path) ?? Promise.resolve()
	const result = prev.then(fn, fn)
	const done = result.then(
		() => {},
		() => {},
	)
	locks.set(path, done)
	done.then(() => {
		if (locks.get(path) === done) locks.delete(path)
	})
	return result
}

// Keep tool outputs under the 1 MB cap even when tsc prints a long error list.
function truncateUtf8(text: string, limit: number): string {
	return helpers.truncateUtf8(text, limit, TRUNCATED_SUFFIX)
}

function shouldTypecheckEditedPath(path: string): boolean {
	const ext = extname(path)
	return ext === '.ts' || ext === '.tsx'
}

async function runCheckForEdit(path: string, script: string, name: string): Promise<string | null> {
	if (!shouldTypecheckEditedPath(path)) return null

	const proc = Bun.spawn(['bun', script, path], {
		cwd: REPO_ROOT,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	if (exitCode === 0) return null

	const details = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
	const fallback = `bun scripts/${name} exited ${exitCode}`
	return truncateUtf8(details || fallback, MAX_OUTPUT_BYTES)
}

function runTypecheckForEdit(path: string): Promise<string | null> {
	return runCheckForEdit(path, TSC_FILE_SCRIPT, 'tsc-file.ts')
}

function runLintForEdit(path: string): Promise<string | null> {
	return runCheckForEdit(path, OXLINT_FILE_SCRIPT, 'oxlint-file.ts')
}

// ── Write tool ──

async function executeWrite(input: any, ctx: ToolContext): Promise<string> {
	const path = read.resolvePath(input?.path, ctx.cwd)
	const denied = ctx.approvedRisk ? null : sensitive.denyIfProtected(path, 'write')
	if (denied) return denied
	const content = String(input?.content ?? '')

	return withLock(path, async () => {
		ensureParent(path)
		await Bun.write(path, content)

		const lines = content.split('\n')
		const preview = lines.slice(0, 5).join('\n')
		if (lines.length <= 5) return `Wrote ${path} (${lines.length} lines)\n${preview}`
		return `Wrote ${path} (${lines.length} lines)\n${preview}\n[+ ${lines.length - 5} more lines]`
	})
}

const writeTool = {
	name: 'write',
	description: 'Create or overwrite a file with the given content.',
	parameters: {
		path: { type: 'string', description: 'File path (absolute or relative to cwd)' },
		content: { type: 'string', description: 'Full file content' },
	},
	required: ['path', 'content'],
	execute: executeWrite,
}

// ── Edit tool ──

async function executeEdit(input: any, ctx: ToolContext): Promise<string> {
	const path = read.resolvePath(input?.path, ctx.cwd)
	const denied = ctx.approvedRisk ? null : sensitive.denyIfProtected(path, 'edit')
	if (denied) return denied
	const operation = input?.operation
	const newContent = String(input?.new_content ?? '')

	if (operation !== 'replace' && operation !== 'insert') {
		return `error: unknown operation "${operation}" (use "replace" or "insert")`
	}

	return withLock(path, async () => {
		let content: string
		try {
			content = readFileSync(path, 'utf-8')
		} catch {
			return `error: file not found: ${path}`
		}

		const prepared = editRemap.prepareEdit({
			lines: hashline.toLines(content),
			sessionId: ctx.sessionId,
			path,
			operation,
			startRef: input?.start,
			endRef: input?.end,
			afterRef: input?.after,
			newContent,
		})
		if (typeof prepared === 'string') return truncateUtf8(prepared, MAX_OUTPUT_BYTES)

		ensureParent(path)
		await Bun.write(path, prepared.resultLines.join('\n') + '\n')
		editRemap.applyTrackerUpdate(ctx.sessionId, path, prepared.trackerUpdate)

		const parts = [editRemap.buildResult(prepared)]
		const [typecheckError, lintError] = await Promise.all([runTypecheckForEdit(path), runLintForEdit(path)])
		if (typecheckError) parts.push(`TypeScript check failed for ${path}:\n${typecheckError}`)
		if (lintError) parts.push(`Oxlint check failed for ${path}:\n${lintError}`)
		return truncateUtf8(parts.join('\n\n'), MAX_OUTPUT_BYTES)
	})
}

const editTool = {
	name: 'edit',
	description: `Edit a file using hashline refs from read. Hashes are verified; line numbers may be remapped after prior edits in the same session.
- replace: replace start..end (inclusive) with new_content. Same ref for single line. Empty new_content to delete.
- insert: insert new_content after after. Use "0:000" for beginning of file.
- if the edited file ends in .ts or .tsx, run tsc-file and oxlint on it and return errors if broken.
new_content is raw file content — no hashline prefixes. A trailing newline in new_content is stripped.`,
	parameters: {
		path: { type: 'string', description: 'File path (absolute or relative to cwd)' },
		operation: { type: 'string', description: '"replace" or "insert"' },
		start: { type: 'string', description: 'LINE:HASH of first line to replace' },
		end: { type: 'string', description: 'LINE:HASH of last line to replace' },
		after: { type: 'string', description: 'LINE:HASH to insert after (or "0:000" for start)' },
		new_content: { type: 'string', description: 'Replacement text (raw, no hashline prefixes)' },
	},
	required: ['path', 'operation', 'new_content'],
	execute: executeEdit,
}

function init(): void {
	toolRegistry.registerTool(writeTool)
	toolRegistry.registerTool(editTool)
}

export const write = { executeWrite, executeEdit, init }
