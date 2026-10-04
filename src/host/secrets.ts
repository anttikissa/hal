// secrets/ (task de): the one owner-only home for credentials, tokens and
// private keys. Every file in it is opened through file(), which makes
// the directory 0700 and writes 0600, so no writer can forget.
// Nothing starts at import.

import { chmodSync, existsSync, renameSync } from 'fs'
import { dirname } from 'path'
import { diag } from './diag.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

type Options = Omit<NonNullable<Parameters<typeof liveFiles.liveFile>[2]>, 'mode'>

// paths.init() makes secrets/ 0700 (and state/, which diag needs).
function dir(): string {
	paths.init()
	return paths.secretsDir()
}

// The live file at `path`, which must be directly in secrets/; mode 0600.
function file<T extends Record<string, any>>(path: string, defaults: T, options: Options = {}): T {
	if (dirname(path) !== paths.secretsDir()) throw new Error(`${path} is not in ${paths.secretsDir()}`)
	secrets.dir()
	return liveFiles.liveFile(path, defaults, { ...options, mode: 0o600 })
}

// Moves each old path (relative to the home) to secrets/<its base name>
// by rename. Never overwrites: when both exist the new one wins and the
// old one stays, named in one diag line.
function migrate(olds: string[]): void {
	let home = paths.home()
	for (let old of olds) {
		let from = `${home}/${old}`
		if (!existsSync(from)) continue
		let to = `${secrets.dir()}/${old.split('/').pop()}`
		if (existsSync(to)) {
			diag.log(`secrets: kept ${paths.display(to)}; old ${paths.display(from)} left in place, remove it once checked`)
			continue
		}
		renameSync(from, to)
		chmodSync(to, 0o600)
	}
}

export const secrets = { dir, file, migrate }
