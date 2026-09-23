// Directory-name completion for path arguments such as `/cd`. Lives in utils so
// the host can answer remote clients whose filesystem is not the host's.

import { basename, resolve, dirname } from 'path'
import { readdirSync, statSync } from 'fs'
import { homedir } from 'os'

function expandTilde(p: string): string {
	if (p === '~') return homedir()
	if (p.startsWith('~/')) return homedir() + p.slice(1)
	return p
}

function listDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => {
				if (entry.name.startsWith('.')) return false
				if (entry.isDirectory()) return true
				if (entry.isSymbolicLink()) {
					try {
						return statSync(resolve(dir, entry.name)).isDirectory()
					} catch {
						return false
					}
				}
				return false
			})
			.map((entry) => entry.name)
			.sort()
	} catch {
		return []
	}
}

// Returns full replacement arguments ending in '/', e.g. 'src/' for 's'.
function complete(argPrefix: string, cwd: string): string[] {
	const expanded = expandTilde(argPrefix)

	let searchDir: string
	let prefix: string
	if (expanded.endsWith('/') || expanded === '') {
		searchDir = expanded === '' ? cwd : resolve(cwd, expanded)
		prefix = ''
	} else {
		searchDir = resolve(cwd, dirname(expanded))
		prefix = basename(expanded)
	}

	const found = listDirs(searchDir)
	const matching = prefix ? found.filter((dir) => dir.startsWith(prefix)) : found
	const base = expanded.endsWith('/')
		? argPrefix
		: argPrefix === ''
			? ''
			: argPrefix.includes('/')
				? argPrefix.slice(0, argPrefix.lastIndexOf('/') + 1)
				: ''

	return matching.map((dir) => base + dir + '/')
}

export const dirs = { complete }
