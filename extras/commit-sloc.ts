// Tells the model and the commit card title how many lines each of its
// commits added net: non-blank, non-comment lines in every text file of
// the commit, tests included; binary files are skipped. Counts only the
// commit's own files, so it stays fast.
// Enable with plugins/commit-sloc.ts (see extras/README.md).
//
// Also rejects background Bash calls that commit: only a foreground call's
// result carries the commit's lines and card. These two concerns
// probably belong in separate plugins, but this is just an example.
import { commits } from '../src/host/commits.ts'
import { fileChanges } from '../src/host/file-changes.ts'
import type { Plugin } from '../src/host/plugins.ts'
import { tool as bashTool } from '../src/host/tools/bash.ts'

// Tested once, then the tests were deleted. If you change this code, first
// write tests for: blank lines, // and /* */ comment lines, tests and tasks
// counted, binary files skipped, files added or deleted.
function count(text: string): number {
	let n = 0, inblock = false
	for (let raw of text.split('\n')) {
		let line = raw
		if (inblock) { if (!line.includes('*/')) continue; inblock = false; line = line.replace(/.*\*\//, '') }
		line = line.trim()
		if (line.startsWith('/*')) { if (!line.includes('*/')) inblock = true; continue }
		if (line && !line.startsWith('//')) n++
	}
	return n
}

async function at(root: string, rev: string, path: string): Promise<number> {
	let out = await fileChanges.git(root, ['show', `${rev}:${path}`])
	return out.code ? 0 : count(out.text)
}

export default (plugin: Plugin) => {
	plugin.around(bashTool, 'run', (next, input, ctx) => {
		if (input.background === true && typeof input.command === 'string' && /git\s+commit/.test(input.command)) throw new Error('git commit must run in the foreground so the user sees the commit; the command did not run. Retry without background.')
		return next(input, ctx)
	})
	plugin.around(commits, 'committed', async (next, info) => {
		let lines = await next(info)
		let paths = info.files.filter((f) => f.added !== -1).map((f) => f.path.slice(info.root.length + 1))
		let net = 0
		for (let p of paths) net += await at(info.root, info.hash, p) - await at(info.root, `${info.hash}~1`, p)
		info.tags.push(`${net >= 0 ? '+' : ''}${net} LOC`)
		return lines
	})
}
