// This process's version (task n1): HEAD plus a short hash of the
// uncommitted diff when present, instead of an ambiguous 'dirty' marker.
// Looked up off the startup path (main.ts runs init after the first
// frame). Then every checkMs it asks git for HEAD again: a new commit
// means new code is ready, and `changed` fires once. Uncommitted edits
// never count: they may be half-written.

import { resolve } from 'path'
import { diag } from './diag.ts'

// Runs git in the checkout; its trimmed output, undefined if it fails.
// Hosts are killed at any moment (tests SIGKILL dozens), so the host only
// reads: --no-optional-locks keeps even reads from taking .git/index.lock,
// which a killed git leaves behind to break the next commit.
async function git(...args: string[]): Promise<string | undefined> {
	try {
		let p = Bun.spawn(['git', '--no-optional-locks', ...args], { cwd: version.dir(), stdout: 'pipe', stderr: 'ignore' })
		let [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
		return code === 0 ? out.trim() : undefined
	} catch {
		return undefined
	}
}

function head(): Promise<string | undefined> {
	return version.git('rev-parse', '--short', 'HEAD')
}

// Finds the loaded version, logs it and starts watching HEAD. Idempotent.
async function init(): Promise<void> {
	let st = version.state
	if (st.started) return
	st.started = true
	// Read-only on purpose: `git stash create` writes .git/index.lock, and
	// hosts killed mid-call (tests start dozens) left it behind for others.
	let [hash, diff] = await Promise.all([version.head(), version.git('diff', 'HEAD')])
	st.head = hash
	let changes = diff ? Bun.hash(diff).toString(16).padStart(7, '0').slice(0, 7) : ''
	st.loaded = hash === undefined ? 'unknown' : changes ? `${hash}+${changes}` : hash
	diag.log(`version ${st.loaded} (${version.dir()})`)
	version.found(st.loaded)
	if (hash === undefined) return
	st.timer = setInterval(() => void version.check(), version.checkMs)
	st.timer.unref?.()
}

// Asks git for HEAD; true (and `changed` once) when it moved since start.
async function check(): Promise<boolean> {
	let st = version.state
	if (st.head === undefined) return false
	let now = await version.head()
	let moved = now !== undefined && now !== st.head
	if (moved && !st.newCode) {
		st.newCode = true
		version.changed()
	}
	return moved
}

function stop(): void {
	clearInterval(version.state.timer)
	version.state = createState()
}

function createState() {
	return { started: false, loaded: undefined as string | undefined, head: undefined as string | undefined, newCode: false, timer: undefined as Timer | undefined }
}

export const version = {
	state: createState(),
	/** The checkout this code was loaded from. */
	dir: (): string => resolve(import.meta.dir, '../..'),
	checkMs: 10_000,
	/** Told the loaded version once it is known (main.ts wires it). */
	found: (_loaded: string): void => {},
	/** Told once when a new commit is checked out. */
	changed: (): void => {},
	git,
	head,
	init,
	check,
	stop,
}
