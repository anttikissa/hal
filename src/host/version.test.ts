// This process's version and the new-code check (task n1), against a
// throwaway git checkout.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { diag } from './diag.ts'
import { version } from './version.ts'

const saved = { dir: version.dir, changed: version.changed, found: version.found, log: diag.log }
let repo = ''

afterEach(() => {
	version.stop()
	Object.assign(version, { dir: saved.dir, changed: saved.changed, found: saved.found })
	diag.log = saved.log
	rmSync(repo, { recursive: true, force: true })
})

function git(...args: string[]): string {
	let out = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo })
	if (out.exitCode !== 0) throw new Error(out.stderr.toString())
	return out.stdout.toString().trim()
}

// A checkout with one commit; what version logs and reports goes to `seen`.
function checkout(seen: string[]): void {
	repo = mkdtempSync(`${tmpdir()}/hal-version-`)
	git('init', '-q')
	writeFileSync(`${repo}/a.ts`, 'one')
	git('add', 'a.ts')
	git('commit', '-qm', 'one')
	version.dir = () => repo
	diag.log = (m) => void seen.push(`log ${m}`)
	version.found = (v) => void seen.push(`found ${v}`)
	version.changed = () => void seen.push('changed')
}

test('a commit after start offers new code once; an uncommitted edit does not', async () => {
	let seen: string[] = []
	checkout(seen)
	let hash = git('rev-parse', '--short', 'HEAD')
	await version.init()
	expect(version.state.loaded).toBe(hash)
	expect(seen).toContain(`found ${hash}`)
	expect(seen.some((s) => s.startsWith(`log version ${hash}`))).toBe(true)

	writeFileSync(`${repo}/a.ts`, 'half-writ')
	expect(await version.check()).toBe(false)
	expect(version.state.newCode).toBe(false)

	git('commit', '-qam', 'two')
	expect(await version.check()).toBe(true)
	expect(await version.check()).toBe(true)
	expect(version.state.newCode).toBe(true)
	expect(seen.filter((s) => s === 'changed')).toHaveLength(1)
	// The loaded version stays what started.
	expect(version.state.loaded).toBe(hash)
})

test('local changes identify their content, not just an ambiguous dirty marker', async () => {
	checkout([])
	writeFileSync(`${repo}/a.ts`, 'edited')
	await version.init()
	let first = version.state.loaded!
	expect(first).toMatch(new RegExp(`^${git('rev-parse', '--short', 'HEAD')}\\+[0-9a-f]{7}$`))
	version.stop()
	writeFileSync(`${repo}/a.ts`, 'edited again')
	await version.init()
	expect(version.state.loaded).not.toBe(first)
})

test('outside a checkout the version is unknown and nothing is watched', async () => {
	checkout([])
	rmSync(`${repo}/.git`, { recursive: true, force: true })
	await version.init()
	expect(version.state.loaded).toBe('unknown')
	expect(version.state.timer).toBeUndefined()
	expect(await version.check()).toBe(false)
})
