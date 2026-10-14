// Who last changed a file through a declared Hal call (tasks 3r4, njq):
// the newest file_changes step across every session, and whether the
// file still holds what that step left. Activity, never a guessed writer.
import { realpathSync } from 'fs'
import { stat } from 'fs/promises'
import { createHash } from 'crypto'
import { basename, dirname, relative, resolve } from 'path'
import type { FileSnapshot } from '../common/replay.ts'
import { changes } from './changes.ts'
import { fileChanges } from './file-changes.ts'
import { fileTracking } from './file-tracking.ts'
import { pages } from './pages.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'

export type Editor = { id: string; call?: number; ts: string; after: FileSnapshot }

// The file's path with its directory's symlinks resolved; the file
// itself may already be renamed away.
function canonical(path: string): string {
	try { return `${realpathSync(dirname(path))}/${basename(path)}` } catch { return resolve(path) }
}

// The newest declared step for each canonical path, over every readable session.
async function all(): Promise<Map<string, Editor>> {
	let out = new Map<string, Editor>()
	for (let s of sessions.list()) {
		if (s.error) continue
		await pages.slices(pages.catchUp(s.id))
		for (let file of changes.list(s.id)) {
			let step = file.steps.at(-1)!, key = fileEditors.canonical(file.path), best = out.get(key)
			if (!best || step.ts > best.ts) out.set(key, { id: s.id, call: step.call, ts: step.ts, after: step.change.after })
		}
	}
	return out
}

async function last(path: string): Promise<Editor | undefined> {
	return (await fileEditors.all()).get(fileEditors.canonical(path))
}

// Whether `path` still holds `snapshot`: its content hash, or size and
// mtime for a metadata-only snapshot.
async function current(path: string, snapshot: FileSnapshot): Promise<boolean> {
	let info
	try { info = await stat(path) } catch (e: any) {
		if (e.code === 'ENOENT') return snapshot === null
		throw e
	}
	if (snapshot === null) return false
	if (typeof snapshot !== 'string') return info.size === snapshot.size && info.mtimeMs === snapshot.mtime
	if (!info.isFile() || info.size > fileChanges.maxBytes) return false
	return createHash('sha256').update(Buffer.from(await Bun.file(path).arrayBuffer())).digest('hex') === snapshot
}

// Absolute paths of the uncommitted files under a Git root, untracked included.
async function uncommitted(root: string): Promise<string[]> {
	let result = await fileChanges.git(root, ['status', '-z', '--porcelain', '--untracked-files=all'])
	if (result.code) throw new Error(`git status in ${root} failed: ${result.error.trim()}`)
	let entries = result.text.split('\0'), out: string[] = []
	for (let i = 0; i < entries.length; i++) {
		let entry = entries[i]!
		if (!entry) continue
		out.push(resolve(root, entry.slice(3)))
		// A rename or copy is followed by its source path.
		if (entry[0] === 'R' || entry[0] === 'C') i++
	}
	return out
}

async function exists(path: string): Promise<boolean> {
	try { await stat(path); return true } catch (e: any) { if (e.code === 'ENOENT') return false; throw e }
}

// One line per file: its last Hal editor, or that it has none.
async function report(cwd: string, scope: 'project' | 'all', timeZone?: string): Promise<string> {
	let root = await fileTracking.repo(cwd)
	if (!root && scope === 'project') return `${cwd} is not in a Git repository. INSPECT { what: "files", scope: "all" } lists every existing file Hal sessions changed.`
	let editors = await fileEditors.all()
	let files = root ? await fileEditors.uncommitted(root) : []
	let seen = new Set(files.map(fileEditors.canonical))
	if (scope === 'all') {
		let project = root ? realpathSync(root) : undefined
		for (let path of editors.keys()) {
			if (seen.has(path) || (project && fileTracking.inside(path, project)) || !await exists(path)) continue
			files.push(path)
			seen.add(path)
		}
	}
	if (!files.length) return root ? `No uncommitted files in ${root}.` : 'No existing files changed by Hal sessions.'
	let open = tabs.list(), base = await fileChanges.canonical(cwd)
	let lines = []
	for (let path of files) {
		let rel = relative(base, path)
		let name = rel && !rel.startsWith('..') && !rel.startsWith('/') ? rel : path
		let editor = editors.get(fileEditors.canonical(path))
		if (!editor) { lines.push(`${name}: no Hal record`); continue }
		let i = open.findIndex((t) => t.id === editor.id)
		let who = i < 0 ? `${editor.id} (closed)` : `${editor.id} (tab ${i + 1}, "${open[i]!.name}")`
		let state = await fileEditors.current(path, editor.after) ? 'current' : 'changed since'
		lines.push(`${name}: ${who}${editor.call === undefined ? '' : ` t${editor.call}`} at ${changes.time(editor.ts, timeZone)} - ${state}`)
	}
	return lines.join('\n')
}

export const fileEditors = { canonical, all, last, current, uncommitted, report }
