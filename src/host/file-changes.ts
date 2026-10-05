// Observations during bash calls, not proof of authorship (task 8w).
import { realpath, stat, mkdir, writeFile } from 'fs/promises'
import { dirname, basename, resolve, relative, isAbsolute } from 'path'
import { createHash } from 'crypto'
import type { FileChange, FileSnapshot } from '../common/replay.ts'
import { approval } from './approval.ts'
import { paths } from './paths.ts'
import { history } from './history.ts'
import { neighbors } from './neighbors.ts'
import type { ToolContext } from './tools.ts'
import { host } from './host.ts'
import { stats } from './stats.ts'
import { commits } from './commits.ts'
import { tabs } from './tabs.ts'
import { jobs } from './jobs.ts'

type Lock = { sessionId: string; callId?: string; paths: Set<string>; done: Promise<void>; release: () => void }
type Observation = { ctx: ToolContext; patterns: string[]; before: Map<string, FileSnapshot>; status: Map<string, string>; commits?: Awaited<ReturnType<typeof commits.begin>>; release: () => void }

function validate(input: unknown): string[] {
	if (input === undefined) return []
	let help = 'Use a list of relative paths/globs or absolute paths/globs beneath /tmp, without ..; the command did not run'
	if (!Array.isArray(input)) throw new Error(`modifies must be a list, received ${JSON.stringify(input)}. ${help}`)
	for (let [i, p] of input.entries()) {
		let reason = typeof p !== 'string' ? 'not a string' : !p ? 'empty path' : p.includes('\0') ? 'contains NUL' : p.split('/').includes('..') ? 'contains parent traversal' : isAbsolute(p) && (!p.startsWith('/tmp/') || resolve(p) === '/tmp') ? 'absolute path outside /tmp' : undefined
		if (reason) throw new Error(`modifies[${i}] (${JSON.stringify(p)}): ${reason}. ${help}`)
	}
	return input.map((p) => isAbsolute(p) ? resolve(p) : relative('/cwd', resolve('/cwd', p)) || '.')
}

// Canonicalize missing files through their nearest existing ancestor too.
async function canonical(path: string): Promise<string> {
	try { return await realpath(path) } catch (e: any) {
		if (e.code !== 'ENOENT') throw e
		return resolve(await fileChanges.canonical(dirname(path)), basename(path))
	}
}

async function expand(cwd: string, patterns: string[]): Promise<string[]> {
	let found = new Set<string>()
	for (let p of patterns) {
		if (!/[*?[\]{}]/.test(p)) found.add(p)
		else for await (let name of new Bun.Glob(isAbsolute(p) ? relative(cwd, p) : p).scan({ cwd, dot: true, onlyFiles: true })) found.add(isAbsolute(p) ? resolve(cwd, name) : name)
	}
	return [...found].sort()
}

async function acquire(ctx: ToolContext, patterns: string[]): Promise<() => void> {
	if (!patterns.length) return () => {}
	for (;;) {
		if (ctx.signal.aborted) throw new Error(`${jobs.why(ctx.signal)}; the command did not run`)
		let names = await fileChanges.expand(ctx.cwd, patterns)
		let keys = new Set(await Promise.all(names.map((p) => fileChanges.canonical(resolve(ctx.cwd, p)))))
		// Reserve glob expressions too: identical globs with no current matches
		// must not both create their first file at the same time.
		for (let p of patterns) keys.add(await fileChanges.canonical(resolve(ctx.cwd, p)))
		let conflict = fileChanges.state.locks.find((l) => [...keys].some((p) => [...l.paths].some((q) => p === q || new Bun.Glob(q).match(p) || new Bun.Glob(p).match(q))))
		if (!conflict) {
			let release!: () => void
			let done = new Promise<void>((r) => { release = r })
			let lock = { sessionId: ctx.sessionId, callId: ctx.callId, paths: keys, done, release }
			fileChanges.state.locks.push(lock)
			return () => {
				fileChanges.state.locks = fileChanges.state.locks.filter((l) => l !== lock)
				release()
			}
		}
		let editing = [...keys].find((p) => conflict.paths.has(p)) ?? [...conflict.paths][0]!
		let tab = tabs.file().open.indexOf(conflict.sessionId)
		let editor = tab >= 0 ? `tab ${tab + 1} (${conflict.sessionId})` : conflict.sessionId
		let path = relative(await fileChanges.canonical(ctx.cwd), editing)
		// A background job holds its lock until exit, even when its own session waits.
		let n = conflict.callId ? history.readSync(conflict.sessionId).findLast((r) => r.type === 'assistant' && r.block.type === 'tool_call' && r.block.id === conflict.callId)?.n : undefined
		let job = n !== undefined && jobs.state.running.has(`${conflict.sessionId}:${n}`) ? `#t${n}` : undefined
		let owner = conflict.sessionId === ctx.sessionId ? 'this session' : editor
		let waiting = job ? `waiting for background job ${job} (${owner}) to exit; it declared ${path}` : `waiting for ${editor} to finish editing ${path}`
		ctx.onOutput?.(`${waiting[0]!.toUpperCase()}${waiting.slice(1)}\n`)
		await new Promise<void>((res, rej) => {
			let abort = () => rej(new Error(`${jobs.why(ctx.signal)} while ${waiting}; the command did not run`))
			ctx.signal.addEventListener('abort', abort, { once: true })
			conflict.done.then(res).finally(() => ctx.signal.removeEventListener('abort', abort))
			if (ctx.signal.aborted) abort()
		})
	}
}

function blobPath(sessionId: string, hash: string): string {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid snapshot hash')
	return `${paths.sessionDir(sessionId)}/file-blobs/${hash}`
}

async function snapshot(ctx: ToolContext, path: string): Promise<FileSnapshot> {
	let absolute = resolve(ctx.cwd, path)
	let info
	try { info = await stat(absolute) } catch (e: any) {
		if (e.code === 'ENOENT') return null
		throw e
	}
	let canonical = await fileChanges.canonical(absolute)
	if (!info.isFile() || info.size > fileChanges.maxBytes || approval.sensitive(absolute) || approval.sensitive(canonical)) return { size: info.size, mtime: info.mtimeMs }
	// Slice bounds the read even if another process grows the file after stat.
	let bytes = Buffer.from(await Bun.file(absolute).slice(0, fileChanges.maxBytes + 1).arrayBuffer())
	if (bytes.length > fileChanges.maxBytes) {
		let latest = await stat(absolute)
		return { size: latest.size, mtime: latest.mtimeMs }
	}
	let hash = createHash('sha256').update(bytes).digest('hex')
	let target = fileChanges.blobPath(ctx.sessionId, hash)
	await mkdir(dirname(target), { recursive: true, mode: 0o700 })
	try { await writeFile(target, bytes, { mode: 0o600, flag: 'wx' }) } catch (e: any) { if (e.code !== 'EEXIST') throw e }
	return hash
}

// Git's -z rename format is destination NUL source NUL; retain both.
function parseStatus(text: string, root: string, cwd: string): Map<string, string> {
	let parts = text.split('\0'), out = new Map<string, string>()
	for (let i = 0; i < parts.length; i++) {
		let item = parts[i]!
		if (!item) continue
		let status = item.slice(0, 2)
		out.set(relative(cwd, resolve(root, item.slice(3))), status)
		if (/[RC]/.test(status)) out.set(relative(cwd, resolve(root, parts[++i]!)), status)
	}
	return out
}

async function git(cwd: string, args: string[]): Promise<{ code: number; text: string; error: string }> {
	let child = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
	let [code, text, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { code, text, error }
}

// Also the HEAD reflog's path for commit notices (commits.ts); worktrees have their own.
async function status(cwd: string): Promise<{ files: Map<string, string>; log?: string }> {
	let root = await fileChanges.git(cwd, ['rev-parse', '--show-toplevel', '--git-path', 'logs/HEAD'])
	if (root.code) {
		if (root.error.includes('not a git repository')) return { files: new Map() }
		throw new Error(root.error)
	}
	let [top, log] = root.text.trimEnd().split('\n')
	let result = await fileChanges.git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
	if (result.code) throw new Error(result.error)
	// git-path is relative to cwd in a main checkout, absolute in a worktree.
	return { files: fileChanges.parseStatus(result.text, top!, await fileChanges.canonical(cwd)), log: await fileChanges.canonical(resolve(cwd, log!)) }
}

async function begin(ctx: ToolContext, patterns: string[]): Promise<Observation> {
	let release = await fileChanges.acquire(ctx, patterns)
	try {
		neighbors.record(ctx.sessionId, ctx.cwd, patterns)
		let before = new Map<string, FileSnapshot>()
		for (let path of await fileChanges.expand(ctx.cwd, patterns)) before.set(path, await fileChanges.snapshot(ctx, path))
		let { files, log } = await fileChanges.status(ctx.cwd)
		return { ctx, patterns, before, status: files, commits: log ? await commits.begin(ctx.sessionId, ctx.cwd, log) : undefined, release }
	} catch (e) { release(); throw e }
}

async function finish(observation: Observation): Promise<void> {
	let { ctx, patterns, before, status, release } = observation
	try {
		let files: FileChange[] = []
		let declared = new Set([...before.keys(), ...await fileChanges.expand(ctx.cwd, patterns)])
		for (let path of declared) {
			let a = before.get(path) ?? null, b = await fileChanges.snapshot(ctx, path)
			if (JSON.stringify(a) !== JSON.stringify(b)) files.push({ path, before: a, after: b })
		}
		let after = (await fileChanges.status(ctx.cwd)).files
		let declaredPaths = new Set([...declared].map((p) => resolve(ctx.cwd, p)))
		for (let path of new Set([...status.keys(), ...after.keys()])) {
			if (!declaredPaths.has(resolve(ctx.cwd, path)) && status.get(path) !== after.get(path)) files.push({ path, undeclared: true, statusBefore: status.get(path) ?? null, statusAfter: after.get(path) ?? null })
		}
		neighbors.record(ctx.sessionId, ctx.cwd, files.map((f) => f.path))
		if (patterns.length || files.length) {
			history.append(ctx.sessionId, { type: 'file_changes', toolId: ctx.callId!, cwd: ctx.cwd, files })
			host.broadcast(ctx.sessionId, { type: 'turn-stats', sessionId: ctx.sessionId, stats: stats.of(ctx.sessionId) })
		}
	} finally {
		if (observation.commits) await commits.finish(observation.commits)
		release()
	}
}

export const fileChanges = {
	state: { locks: [] as Lock[] },
	maxBytes: 1_000_000,
	validate, canonical, expand, acquire, blobPath, snapshot, parseStatus, git, status, begin, finish,
}
