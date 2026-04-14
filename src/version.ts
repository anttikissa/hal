import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { HAL_DIR } from './state.ts'

export type VersionStatus = 'idle' | 'pending' | 'ready' | 'error'

interface VersionState {
	status: VersionStatus
	repoDir: string
	head: string
	dirtyHash: string
	combined: string
	error: string
}

const state: VersionState = {
	status: 'idle',
	repoDir: HAL_DIR,
	head: '',
	dirtyHash: '',
	combined: '',
	error: '',
}

const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null

function notify(): void {
	for (const listener of listeners) listener()
}

function formatCombined(head: string, dirtyHash: string): string {
	return dirtyHash ? `${head}+${dirtyHash}` : head
}

function copyEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
	const env: Record<string, string> = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === 'string') env[key] = value
	}
	for (const [key, value] of Object.entries(extra)) {
		if (typeof value === 'string') env[key] = value
	}
	return env
}

async function runGit(args: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }): Promise<string> {
	const proc = Bun.spawn(['git', ...args], {
		cwd: opts?.cwd ?? state.repoDir,
		env: copyEnv(opts?.env),
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const stdoutPromise = new Response(proc.stdout).text()
	const stderrPromise = new Response(proc.stderr).text()
	const code = await proc.exited
	const stdout = (await stdoutPromise).trim()
	const stderr = (await stderrPromise).trim()
	if (code !== 0) throw new Error(stderr || stdout || `git ${args.join(' ')} exited ${code}`)
	return stdout
}

async function readHead(repoDir = HAL_DIR): Promise<string> {
	return await runGit(['rev-parse', '--short=8', 'HEAD'], { cwd: repoDir })
}

async function hasDirty(repoDir = HAL_DIR): Promise<boolean> {
	const out = await runGit(['status', '--porcelain', '--untracked-files=normal'], { cwd: repoDir })
	return out.length > 0
}

async function readDirtyTreeHash(repoDir = HAL_DIR): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), 'hal-version-'))
	const indexPath = join(tempDir, 'index')
	try {
		// Compute the exact tree object for the working copy without touching the
		// real index. This is much closer to a jj-style working copy hash than a
		// plain diff hash, and it includes untracked files too.
		await runGit(['read-tree', 'HEAD'], { cwd: repoDir, env: { GIT_INDEX_FILE: indexPath } })
		await runGit(['add', '-A'], { cwd: repoDir, env: { GIT_INDEX_FILE: indexPath } })
		return await runGit(['write-tree'], { cwd: repoDir, env: { GIT_INDEX_FILE: indexPath } })
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
}

async function refresh(repoDir = HAL_DIR): Promise<void> {
	state.repoDir = repoDir
	if (inflight) return await inflight
	state.status = 'pending'
	state.error = ''
	notify()
	inflight = (async () => {
		try {
			const head = await version.io.readHead(repoDir)
			const dirty = await version.io.hasDirty(repoDir)
			const dirtyHash = dirty ? (await version.io.readDirtyTreeHash(repoDir)).slice(0, 8) : ''
			state.status = 'ready'
			state.head = head
			state.dirtyHash = dirtyHash
			state.combined = formatCombined(head, dirtyHash)
			state.error = ''
		} catch (err: any) {
			state.status = 'error'
			state.head = ''
			state.dirtyHash = ''
			state.combined = ''
			state.error = err?.message ?? String(err)
		} finally {
			inflight = null
			notify()
		}
	})()
	return await inflight
}

function start(repoDir = HAL_DIR): void {
	void refresh(repoDir)
}

function onChange(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

function resetForTests(): void {
	inflight = null
	state.status = 'idle'
	state.repoDir = HAL_DIR
	state.head = ''
	state.dirtyHash = ''
	state.combined = ''
	state.error = ''
	listeners.clear()
}

export const version = {
	state,
	io: {
		runGit,
		readHead,
		hasDirty,
		readDirtyTreeHash,
	},
	formatCombined,
	refresh,
	start,
	onChange,
	resetForTests,
}
