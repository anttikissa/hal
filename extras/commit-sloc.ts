// Tells the model and the commit card title how many source lines each
// of its commits added, by the rules of scripts/sloc (non-blank,
// non-comment lines in non-test .ts/.tsx files). Counts only the
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

const source = (path: string) => /\.(ts|tsx)$/.test(path) && !/(\.test\.tsx?$|\/tests?\/|test-|\.d\.ts$|^tasks\/|^docs\/)/.test(path)

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
		let paths = info.files.map((f) => f.path.slice(info.root.length + 1)).filter(source)
		let net = 0
		for (let p of paths) net += await at(info.root, info.hash, p) - await at(info.root, `${info.hash}~1`, p)
		info.tags.push(`${net >= 0 ? '+' : ''}${net} LOC`)
		return lines
	})
}
