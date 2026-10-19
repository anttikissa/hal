// Rewrites each commit card file row to the code lines (non-blank,
// non-comment) the commit added and removed, and tags the card title and
// tells the model the net code lines over source files by scripts/sloc
// rules (non-test .ts/.tsx). Tests, tasks and other text files keep their
// rows but stay out of the total; binary files are left as they are.
// Enable with plugins/commit-sloc.ts (see extras/README.md).
//
// Also rejects background Bash calls that commit: only a foreground call's
// result carries the commit's lines and card. These two concerns
// probably belong in separate plugins, but this is just an example.
import { commits } from '../src/host/commits.ts'
import { fileChanges } from '../src/host/file-changes.ts'
import type { Plugin } from '../src/host/plugins.ts'
import { tool as bashTool } from '../src/host/tools/bash.ts'

const source = (path: string) =>
	/\.(ts|tsx)$/.test(path) && !/(\.test\.tsx?$|\/tests?\/|test-|\.d\.ts$|^tasks\/|^docs\/)/.test(path)

// Tested once, then the tests were deleted. If you change this code, first
// write tests for: blank lines, // and /* */ comment lines (a changed line
// inside an unchanged block comment), added and deleted files, binary
// files kept, tests and tasks out of the total.
function code(lines: string[]): boolean[] {
	let inblock = false
	return lines.map((raw) => {
		let line = raw
		if (inblock) {
			if (!line.includes('*/')) return false
			inblock = false
			line = line.replace(/.*\*\//, '')
		}
		line = line.trim()
		if (line.startsWith('/*')) {
			if (!line.includes('*/')) inblock = true
			return false
		}
		return !!line && !line.startsWith('//')
	})
}

// Counts one file's diff section, read with whole-file context so each
// changed line is judged in place: a line inside an unchanged /* */ block
// is a comment.
function changed(rows: string[]): { added: number; removed: number } {
	let start = rows.findIndex((r) => r.startsWith('@@'))
	let before: { text: string; changed: boolean }[] = [],
		after: { text: string; changed: boolean }[] = []
	for (let r of start < 0 ? [] : rows.slice(start)) {
		let text = r.slice(1)
		if (r[0] === ' ') {
			before.push({ text, changed: false })
			after.push({ text, changed: false })
		}
		if (r[0] === '-') before.push({ text, changed: true })
		if (r[0] === '+') after.push({ text, changed: true })
	}
	let count = (side: typeof before) => {
		let isCode = code(side.map((l) => l.text))
		return side.filter((l, i) => l.changed && isCode[i]).length
	}
	return { added: count(after), removed: count(before) }
}

export default (plugin: Plugin) => {
	plugin.around(bashTool, 'run', (next, input, ctx) => {
		if (input.background === true && typeof input.command === 'string' && /git\s+commit/.test(input.command))
			throw new Error(
				'git commit must run in the foreground so the user sees the commit; the command did not run. Retry without background.',
			)
		return next(input, ctx)
	})
	plugin.around(commits, 'committed', async (next, info) => {
		let lines = await next(info)
		// One Git call for the whole commit: each process costs ~17 ms.
		let out = await fileChanges.git(info.root, [
			'show',
			'--format=',
			'--no-renames',
			'--no-ext-diff',
			'--no-textconv',
			'--no-color',
			'-U1000000',
			info.hash,
		])
		if (out.code) throw new Error(out.error)
		// Sections come in numstat order, one per file.
		let sections = out.text.split(/^diff --git /m).slice(1)
		if (sections.length !== info.files.length)
			throw new Error(`${info.short}: ${sections.length} diff sections for ${info.files.length} files`)
		let net = 0
		info.files.forEach((f, i) => {
			if (f.added === -1) return
			Object.assign(f, changed(sections[i]!.split('\n')))
			if (source(f.path.slice(info.root.length + 1))) net += f.added - f.removed
		})
		info.tags.push(`${net >= 0 ? '+' : ''}${net} LOC`)
		return lines
	})
}
