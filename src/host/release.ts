// Which release a commit is (task jjr), for hal --version and /version.
// Loaded only by those two, never on the startup path. Releases are
// tags v<version> on the commit that sets package.json's version.

import { readFileSync } from 'fs'
import { version } from './version.ts'

// package.json's version at `commit`; the file on disk without git.
async function packageVersion(commit: string | undefined): Promise<string> {
	let text = commit ? await version.git('show', `${commit}:package.json`) : undefined
	try {
		return JSON.parse(text ?? readFileSync(`${version.dir()}/package.json`, 'utf8')).version ?? 'unknown'
	} catch {
		return 'unknown'
	}
}

// "hal 0.0.1 (release)", "hal 0.0.1 +3 commits, modified", or
// "hal 0.0.2 (unreleased; v0.0.1 +3 commits)" when package.json names a
// version that has no tag yet.
async function line(commit: string | undefined, modified: boolean): Promise<string> {
	let pkg = await packageVersion(commit)
	let mod = modified ? ', modified' : ''
	if (!commit) return `hal ${pkg} (not a git checkout)`
	let m = /^v(.+)-(\d+)-g[0-9a-f]+$/.exec((await version.git('describe', '--tags', '--long', '--match', 'v*', commit)) ?? '')
	if (!m) return `hal ${pkg} (untagged${mod})`
	let [, tag, n] = m as unknown as [string, string, string]
	let since = n === '0' ? '' : ` +${n} commit${n === '1' ? '' : 's'}`
	if (tag !== pkg) return `hal ${pkg} (unreleased; v${tag}${since}${mod})`
	return since || mod ? `hal ${pkg}${since}${mod}` : `hal ${pkg} (release)`
}

// hal --version: the release, the exact commit and the checkout, now.
async function cli(): Promise<string> {
	let { hash, loaded } = await version.current()
	return `${await line(hash, loaded.includes('+'))}\ngit ${loaded}\ndir ${version.dir()}\n`
}

export const release = { line, cli }
