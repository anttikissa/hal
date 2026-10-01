// Durable per-session file observations, independent of Git's working tree.
import { resolve, relative } from 'path'
import type { FileChange, FileSnapshot, HistoryRecord } from '../common/replay.ts'
import { fileChanges } from './file-changes.ts'
import { history } from './history.ts'
import { pages } from './pages.ts'

export type Step = { toolId: string; n?: number; ts: string; change: FileChange }
export type ChangedFile = { path: string; cwd: string; name: string; steps: Step[]; before?: FileSnapshot; after?: FileSnapshot; undeclared: boolean; ts: string }

function collect(records: HistoryRecord[]): ChangedFile[] {
	let files = new Map<string, ChangedFile>()
	for (let r of records) {
		if (r.type === 'command' && r.text.trim() === '/changes clear') files.clear()
		if (r.type !== 'file_changes') continue
		for (let change of r.files) {
			let path = resolve(r.cwd, change.path)
			let file = files.get(path)
			if (!file) {
				file = { path, cwd: r.cwd, name: change.path, steps: [], before: change.undeclared ? undefined : change.before, undeclared: false, ts: r.ts }
				files.set(path, file)
			}
			file.steps.push({ toolId: r.toolId, n: r.n, ts: r.ts, change })
			file.ts = r.ts
			if (change.undeclared) {
				file.undeclared = true
				file.after = undefined
			} else file.after = change.after
		}
	}
	return [...files.values()]
}

function list(id: string): ChangedFile[] {
	let marks = pages.marks(id)
	let size = marks.size
	let cached = changes.state.cache.get(id)
	if (cached?.size === size) return cached.files
	let files = changes.collect((marks.changes ?? []).map((offset) => pages.lineAt(history.file(id), offset).record))
	changes.state.cache.set(id, { size, files })
	return files
}

async function run(args: string[], cwd?: string): Promise<{ code: number; bytes: Buffer }> {
	let p = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'ignore', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' } })
	let [bytes, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), p.exited])
	return { code, bytes: Buffer.from(bytes) }
}

async function diff(id: string, before: FileSnapshot | undefined, after: FileSnapshot | undefined): Promise<string> {
	if (before === undefined || after === undefined) return 'Undeclared observation: content was not captured.\n'
	if ((before !== null && typeof before !== 'string') || (after !== null && typeof after !== 'string')) return 'Content unavailable: sensitive, large or non-regular file (metadata only).\n'
	let a = before === null ? '/dev/null' : fileChanges.blobPath(id, before)
	let b = after === null ? '/dev/null' : fileChanges.blobPath(id, after)
	if (a === b) return 'No net content change.\n'
	let result = await changes.run(['git', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', a, b])
	if (result.code > 1) throw new Error('cannot read captured diff')
	// Do not expose private blob storage paths in the diff headers.
	let hunk = false
	return result.bytes.toString('utf8').split('\n').map((line) => {
		if (line.startsWith('@@')) hunk = true
		return hunk ? line : line.replaceAll(a, 'before').replaceAll(b, 'after')
	}).join('\n')
}

function counts(diff: string): string {
	let lines = diff.split('\n')
	if (diff === 'No net content change.\n') return '+0 -0'
	if (!lines.some((l) => l.startsWith('@@'))) return '+? -?'
	let added = 0, removed = 0, hunk = false
	for (let line of lines) {
		if (line.startsWith('@@')) hunk = true
		else if (hunk && line.startsWith('+')) added++
		else if (hunk && line.startsWith('-')) removed++
	}
	return `+${added} -${removed}`
}

async function committed(_id: string, file: ChangedFile): Promise<string | undefined> {
	if (!Object.hasOwn(file, 'after') || (file.after !== null && typeof file.after !== 'string')) return
	let root = await changes.run(['git', '-C', file.cwd, 'rev-parse', '--show-toplevel'])
	if (root.code) return
	let cwd = root.bytes.toString().trim()
	let name = relative(cwd, await fileChanges.canonical(file.path))
	if (name === '..' || name.startsWith('../')) return
	let since = new Date(Math.floor(Date.parse(file.ts) / 1000) * 1000).toISOString()
	let log = await changes.run(['git', 'log', '--format=%H', `--since=${since}`, '--', name], cwd)
	if (log.code) {
		// A repository with no commits yet has no history to label.
		if ((await changes.run(['git', 'rev-parse', '-q', '--verify', 'HEAD'], cwd)).code) return
		throw new Error('cannot read Git commit history')
	}
	for (let hash of log.bytes.toString().trim().split('\n').filter(Boolean)) {
		if (file.after === null) {
			let tree = await changes.run(['git', 'ls-tree', '-z', hash, '--', name], cwd)
			if (tree.code) throw new Error('cannot read Git commit tree')
			if (!tree.bytes.length) return hash.slice(0, 8)
		} else {
			let content = await changes.run(['git', 'show', `${hash}:${name}`], cwd)
			if (content.code === 0 && new Bun.CryptoHasher('sha256').update(content.bytes).digest('hex') === file.after) return hash.slice(0, 8)
		}
	}
}

function href(id: string, path?: string): string {
	return `/changes/${id}${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`
}

export const changes = { state: { cache: new Map<string, { size: number; files: ChangedFile[] }>() }, collect, list, run, diff, counts, committed, href }
