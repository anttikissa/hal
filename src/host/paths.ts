// Where Hal reads and writes. Everything lives under the home, the repo
// root (git clone is the only install). HAL_HOME is for tests only: it
// points a process at a temp home so it never touches live data.

import { chmodSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'

const repoRoot = resolve(import.meta.dir, '../..')

function home(): string {
	if (process.env.HAL_HOME) return process.env.HAL_HOME
	// Belt and braces: a test that forgot HAL_HOME still gets a temp home.
	if (process.env.NODE_ENV === 'test') return `${tmpdir()}/hal-test-home-${process.pid}`
	return repoRoot
}

// Conversations, one directory per session.
function sessionsDir(): string {
	return `${paths.home()}/sessions`
}

function sessionDir(id: string): string {
	if (!/^[\w-]+$/.test(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`)
	return `${paths.sessionsDir()}/${id}`
}

// Pasted images by name until a prompt copies them into a session
// blob (task qy): /tmp/hal/image, where the model's tools can read them
// too; inside the home under test, so tests never touch /tmp/hal.
function imageDir(): string {
	return process.env.HAL_HOME || process.env.NODE_ENV === 'test' ? `${paths.home()}/tmp/image` : '/tmp/hal/image'
}

// Everything else: socket, host lock, diagnostics, later peer and access
// keys. Owner-only.
function stateDir(): string {
	return `${paths.home()}/state`
}

// This home's credentials: copied in by the user or written by /login
// claude (src/host/login.ts); refreshed OAuth tokens go back here
// (src/host/auth.ts).
function authFile(): string {
	return `${paths.home()}/auth.ason`
}

// Common settings, user-edited like a dotfile (src/host/config.ts).
function configFile(): string {
	return `${paths.home()}/config.ason`
}

// Idempotent. chmod (unlike mkdir's mode) ignores umask and also tightens
// a state/ created earlier with looser permissions.
function init(): void {
	mkdirSync(paths.sessionsDir(), { recursive: true })
	mkdirSync(paths.stateDir(), { recursive: true })
	chmodSync(paths.stateDir(), 0o700)
}

// ~/… form for showing paths to the user.
function display(path: string): string {
	let userHome = process.env.HOME
	if (!userHome) return path
	if (path === userHome) return '~'
	if (path.startsWith(`${userHome}/`)) return `~/${path.slice(userHome.length + 1)}`
	return path
}

export const paths = { repoRoot: (): string => repoRoot, home, sessionsDir, sessionDir, imageDir, stateDir, authFile, configFile, init, display }
