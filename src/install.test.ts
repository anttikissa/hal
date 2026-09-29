// ./install against a temp HOME: Bun and node_modules are already
// there (this checkout), so it only links hal and fixes the PATH.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname } from 'path'

const repo = dirname(import.meta.dir)
let home = ''
afterEach(() => rmSync(home, { recursive: true, force: true }))

function install(env: Record<string, string>, ...args: string[]): { code: number; out: string } {
	let p = Bun.spawnSync([`${repo}/install`, ...args], { env: { HOME: home, SHELL: '/bin/zsh', ...env }, stdin: 'ignore' })
	return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}

test('links hal, adds the PATH line once, then finds everything in order', () => {
	home = mkdtempSync(`${tmpdir()}/hal-install-`)
	let path = `${dirname(process.execPath)}:/usr/bin:/bin`
	let first = install({ PATH: path }, '-y')
	expect(first.code).toBe(0)
	expect(readlinkSync(`${home}/.local/bin/hal`)).toBe(`${repo}/run`)
	expect(readFileSync(`${home}/.zshenv`, 'utf8')).toContain('export PATH="$HOME/.local/bin:$PATH"')
	// A shell that has not reloaded its config: nothing is added twice.
	expect(install({ PATH: path }, '-y').code).toBe(0)
	expect(readFileSync(`${home}/.zshenv`, 'utf8').split('.local/bin').length).toBe(2)
	let done = install({ PATH: `${home}/.local/bin:${path}` })
	expect(done.out).toContain('Everything in order')
})
