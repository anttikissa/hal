// Which release a commit is (task jjr), against a throwaway checkout.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { release } from './release.ts'
import { version } from './version.ts'

const dir = version.dir
let repo = ''
afterEach(() => ((version.dir = dir), rmSync(repo, { recursive: true, force: true })))

function git(...args: string[]): string {
	let out = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: repo })
	if (out.exitCode !== 0) throw new Error(out.stderr.toString())
	return out.stdout.toString().trim()
}

function commit(pkg: string): string {
	writeFileSync(`${repo}/package.json`, JSON.stringify({ name: 'hal', version: pkg }))
	git('add', '.')
	git('commit', '-qm', pkg, '--allow-empty')
	return git('rev-parse', '--short', 'HEAD')
}

test('a tag marks the release; later commits, edits and untagged versions say so', async () => {
	repo = mkdtempSync(`${tmpdir()}/hal-release-`)
	version.dir = () => repo
	git('init', '-q')
	let first = commit('0.0.1')
	expect(await release.line(first, false)).toBe('hal 0.0.1 (untagged)')
	git('tag', '-a', 'v0.0.1', '-m', 'v0.0.1')
	expect(await release.line(first, false)).toBe('hal 0.0.1 (release)')
	expect(await release.line(first, true)).toBe('hal 0.0.1, modified')
	let next = commit('0.0.1')
	expect(await release.line(next, false)).toBe('hal 0.0.1 +1 commit')
	let bumped = commit('0.0.2')
	expect(await release.line(bumped, true)).toBe('hal 0.0.2 (unreleased; v0.0.1 +2 commits, modified)')
	// /version describes the commit the host started from, not HEAD.
	expect(await release.line(first, false)).toBe('hal 0.0.1 (release)')
	expect(await release.line(undefined, false)).toBe('hal 0.0.2 (not a git checkout)')
})
