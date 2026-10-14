// Which release a commit is (task jjr), for hal --version, /version and
// the hal serve log. Never on the terminal's startup path. Releases are
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

// The newest v* tag at or before `commit`, and how many commits follow it.
async function tagged(commit: string): Promise<{ tag: string; n: number } | undefined> {
	let m = /^v(.+)-(\d+)-g[0-9a-f]+$/.exec((await version.git('describe', '--tags', '--long', '--match', 'v*', commit)) ?? '')
	return m ? { tag: m[1]!, n: Number(m[2]) } : undefined
}

// `loaded` is version.current()'s form: "<commit>[+<diff hash>]" or
// 'unknown'. "hal 0.0.1" exactly at a release; "hal 0.0.1 4bfdbf8c" after
// it; "hal 0.0.1 4bfdbf8c+bf53f42" with uncommitted changes.
async function line(loaded: string): Promise<string> {
	if (loaded === 'unknown') return `hal ${await packageVersion(undefined)} (not a git checkout)`
	let commit = loaded.split('+')[0]!
	let [pkg, t] = await Promise.all([packageVersion(commit), tagged(commit)])
	return t?.tag === pkg && t.n === 0 && !loaded.includes('+') ? `hal ${pkg}` : `hal ${pkg} ${loaded}`
}

// "683 commits since v0.0.1"; undefined at a release or outside git.
async function since(loaded: string): Promise<string | undefined> {
	if (loaded === 'unknown') return undefined
	let t = await tagged(loaded.split('+')[0]!)
	if (!t) return 'no release tagged yet'
	return t.n ? `${t.n} commit${t.n === 1 ? '' : 's'} since v${t.tag}` : undefined
}

// hal --version: the version, commits since the release and the checkout.
async function cli(): Promise<string> {
	let { loaded } = await version.current()
	let s = await since(loaded)
	return `${await line(loaded)}\n${s ? `${s}\n` : ''}dir ${version.dir()}\n`
}

export const release = { line, since, cli }
