// Git helpers — lightweight, no spawning processes.
// Reads .git/HEAD directly to get the current branch name.

import { readFileSync } from 'fs'
import { resolve } from 'path'

// Read the current git branch from .git/HEAD in the given directory.
// Returns empty string if not a git repo or HEAD is detached.
function currentBranch(cwd: string): string {
	try {
		const head = readFileSync(resolve(cwd, '.git/HEAD'), 'utf-8').trim()
		// "ref: refs/heads/main" → "main"
		if (head.startsWith('ref: refs/heads/')) return head.slice(16)
		// Detached HEAD (raw commit hash) — return empty
		return ''
	} catch {
		return ''
	}
}

export const git = { currentBranch }
