// Where Hal reads and writes. Everything lives under the home: the repo
// root (git clone is the only install), or state.home, set by
// hal --home <dir> or by a test so it never touches live data.

import { chmodSync, lstatSync, mkdirSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { resolve } from 'path'
import { attachments } from '../common/attachments.ts'

const repoRoot = resolve(import.meta.dir, '../..')

function home(): string {
	if (paths.state.home) return paths.state.home
	// Belt and braces: a test that forgot state.home still gets a temp home.
	if (process.env.NODE_ENV === 'test') return `${tmpdir()}/hal-test-home-${process.pid}`
	return repoRoot
}

// The user's home, for user-scoped files such as ~/.agents/skills. Tests
// get a missing directory, so they never read the user's files.
function userHome(): string {
	return process.env.NODE_ENV === 'test' ? `${tmpdir()}/hal-test-user-${process.pid}` : homedir()
}

// Conversations, one directory per session.
function sessionsDir(): string {
	return `${paths.home()}/sessions`
}

function sessionDir(id: string): string {
	if (!/^[\w-]+$/.test(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`)
	return `${paths.sessionsDir()}/${id}`
}

// Pasted images and long texts by name until a prompt copies them into
// a session blob (tasks qy, 31): /tmp/hal/image and /tmp/hal/paste,
// where the model's tools can read them too; inside the home under
// test, so tests never touch /tmp/hal. When another user owns /tmp/hal,
// the first of /tmp/hal1-9, /tmp/hala-z that is free or ours is used:
// only a directory this user owns, so pastes are never readable by others.
function tmpDir(): string {
	if (paths.state.home || process.env.NODE_ENV === 'test') return `${paths.home()}/tmp`
	return (paths.state.tmp ??= pickTmpDir())
}

function pickTmpDir(): string {
	for (let suffix of ['', ...'123456789abcdefghijklmnopqrstuvwxyz']) {
		let dir = `/tmp/hal${suffix}`
		try {
			mkdirSync(dir, { mode: 0o700 })
			return dir
		} catch {}
		let stat = lstatSync(dir, { throwIfNoEntry: false })
		if (stat?.isDirectory() && stat.uid === process.getuid?.()) {
			chmodSync(dir, 0o700)
			return dir
		}
	}
	return `${tmpdir()}/hal`
}

// Picks tmpDir again after a write in it failed (say, /tmp was cleaned
// and another user took the name); false when the pick is unchanged.
function repickTmpDir(): boolean {
	if (paths.state.home || process.env.NODE_ENV === 'test') return false
	let old = paths.state.tmp
	paths.state.tmp = undefined
	return paths.tmpDir() !== old
}

function imageDir(): string {
	return `${paths.tmpDir()}/image`
}

// Where pasted file `name` (attachments.fileName) waits.
function fileDir(name?: string): string {
	if (name === undefined) return `${paths.tmpDir()}/file`
	let type = attachments.nameType(name)
	return type === 'text/plain'
		? `${paths.tmpDir()}/paste`
		: type === 'application/octet-stream'
			? `${paths.tmpDir()}/file`
			: paths.imageDir()
}

// Everything else without credentials: socket, host lock, diagnostics,
// caches. Owner-only.
function stateDir(): string {
	return `${paths.home()}/state`
}

// Credentials, tokens and private keys, and nothing else (task de):
// owner-only, every file 0600, written through src/host/secrets.ts.
function secretsDir(): string {
	return `${paths.home()}/secrets`
}

// This home's provider credentials: written by /login (src/host/login.ts)
// or copied in; refreshed OAuth tokens go back here (src/host/auth.ts).
function authFile(): string {
	return `${paths.secretsDir()}/auth.ason`
}

// Common settings, user-edited like a dotfile (src/host/config.ts).
function configFile(): string {
	return `${paths.home()}/config.ason`
}

// Idempotent. chmod (unlike mkdir's mode) ignores umask and also tightens
// a state/ or secrets/ created earlier with looser permissions.
function init(): void {
	mkdirSync(paths.sessionsDir(), { recursive: true })
	for (let dir of [paths.stateDir(), paths.secretsDir()]) {
		mkdirSync(dir, { recursive: true })
		chmodSync(dir, 0o700)
	}
}

// ~/… form for showing paths to the user.
function display(path: string): string {
	let userHome = process.env.HOME
	if (!userHome) return path
	if (path === userHome) return '~'
	if (path.startsWith(`${userHome}/`)) return `~/${path.slice(userHome.length + 1)}`
	return path
}

// Expands a leading ~ to the user's home, for paths the model gives tools.
function expand(path: string): string {
	return path.replace(/^~(?=\/|$)/, paths.userHome())
}

export const paths = {
	state: { home: undefined as string | undefined, tmp: undefined as string | undefined },
	repoRoot: (): string => repoRoot,
	home,
	userHome,
	sessionsDir,
	sessionDir,
	tmpDir,
	repickTmpDir,
	imageDir,
	fileDir,
	stateDir,
	secretsDir,
	authFile,
	configFile,
	init,
	display,
	expand,
}
