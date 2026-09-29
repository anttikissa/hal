import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { paths } from './paths.ts'

const saved = process.env.HAL_HOME
let temps: string[] = []

function tempHome(): string {
	let dir = mkdtempSync(`${tmpdir()}/hal-paths-`)
	temps.push(dir)
	process.env.HAL_HOME = dir
	return dir
}

afterEach(() => {
	if (saved === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = saved
	for (let t of temps) rmSync(t, { recursive: true, force: true })
	temps = []
})

const mode = (p: string) => statSync(p).mode & 0o777

test('all paths follow HAL_HOME, read at call time', () => {
	let home = tempHome()
	for (let p of [paths.sessionsDir(), paths.sessionDir('abc'), paths.stateDir(), paths.authFile()]) {
		expect(p.startsWith(`${home}/`)).toBe(true)
	}
	expect(paths.sessionDir('abc').startsWith(`${paths.sessionsDir()}/`)).toBe(true)
	expect(paths.stateDir()).not.toBe(paths.sessionsDir())
})

test('session ids cannot escape sessions/', () => {
	tempHome()
	for (let bad of ['', '..', '../state', 'a/b', '/etc']) expect(() => paths.sessionDir(bad)).toThrow()
})

test('init creates sessions/ and an owner-only state/, even under a loose umask, and tightens an existing one', () => {
	let home = tempHome()
	let old = process.umask(0)
	try {
		paths.init()
	} finally {
		process.umask(old)
	}
	expect(statSync(`${home}/sessions`).isDirectory()).toBe(true)
	expect(mode(`${home}/state`)).toBe(0o700)
	// Again, over an existing loose state/: it tightens it.
	chmodSync(`${home}/state`, 0o755)
	paths.init()
	expect(mode(`${home}/state`)).toBe(0o700)
})
