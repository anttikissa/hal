// On-demand text diff generation, independent of its consumers (task k8y).
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { paths } from './paths.ts'

// `numbered`: each row keeps its sign and the line's number, the old
// file's for removals and the new file's otherwise ("-26 text", "+26 text").
function text(before: string, after: string, limit = Infinity, numbered = false): string {
	if (before === after) return ''
	let root = paths.tmpDir()
	mkdirSync(root, { recursive: true })
	let dir = mkdtempSync(`${root}/diff-`)
	try {
		writeFileSync(`${dir}/a`, before, { mode: 0o600 })
		writeFileSync(`${dir}/b`, after, { mode: 0o600 })
		let result = Bun.spawnSync([
			'git',
			'diff',
			'--no-index',
			'--no-ext-diff',
			'--no-textconv',
			'--no-color',
			'--text',
			'-U1',
			'--',
			`${dir}/a`,
			`${dir}/b`,
		])
		if (result.exitCode !== 0 && result.exitCode !== 1)
			throw new Error(
				`git diff failed (${result.exitCode}) at ${dir}:\n${result.stderr.toString()}${result.stdout.toString()}`,
			)
		let lines = hunks(result.stdout.toString())
		if (!lines) return result.stdout.toString().trimEnd()
		if (numbered) {
			let width = String(Math.max(before.split('\n').length, after.split('\n').length)).length,
				old = 0,
				now = 0
			lines = lines.flatMap((line) => {
				let hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)
				if (hunk) {
					old = +hunk[1]!
					now = +hunk[2]!
					return ['…']
				}
				if (line.startsWith('\\')) return []
				let n = line[0] === '-' ? old++ : line[0] === '+' ? now++ : (old++, now++)
				return [`${line[0]}${String(n).padStart(width)} ${line.slice(1).replace(/\r$/, '')}`]
			})
		} else lines = lines.map((line) => (line.startsWith('@@') ? '…' : line))
		if (lines[0] === '…') lines.shift()
		let more = lines.length - limit
		return [...lines.slice(0, limit), ...(more > 0 ? [`… ${more} more lines`] : [])].join('\n')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

// Git output's hunk rows, file headers stripped (not content lines
// beginning with --- or +++); undefined without hunks.
function hunks(out: string): string[] | undefined {
	let lines = out.split('\n'),
		start = lines.findIndex((line) => line.startsWith('@@'))
	return start < 0 ? undefined : lines.slice(start).filter((line) => line !== '')
}

// A three-way merge of `ours` and `theirs` from `base`: the merged text,
// with conflict markers when `conflicts` (their count) is above 0, and
// `view`, git's combined diff of it against ours (first column) and
// theirs (second).
function merge(base: string, ours: string, theirs: string): { text: string; conflicts: number; view: string } {
	let root = paths.tmpDir()
	mkdirSync(root, { recursive: true })
	let dir = mkdtempSync(`${root}/merge-`)
	let git = (args: string[], stdin?: string) => {
		let r = Bun.spawnSync(['git', '-C', dir, ...args], { stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin) })
		if (r.exitCode < 0 || r.exitCode > 127 || (r.exitCode && args[0] !== 'merge-file'))
			throw new Error(`git ${args[0]} failed (${r.exitCode}) at ${dir}:\n${r.stderr.toString()}`)
		return { out: r.stdout.toString(), code: r.exitCode }
	}
	try {
		writeFileSync(`${dir}/base`, base, { mode: 0o600 })
		writeFileSync(`${dir}/f`, ours, { mode: 0o600 })
		writeFileSync(`${dir}/server`, theirs, { mode: 0o600 })
		git(['init', '-q'])
		// The three versions as merge stages, so git diff shows the merge.
		let ids = git(['hash-object', '-w', 'base', 'f', 'server']).out.trim().split('\n')
		git(['update-index', '--index-info'], ids.map((id, i) => `100644 ${id} ${i + 1}\tf\n`).join(''))
		let names = ['-L', 'local', '-L', 'base', '-L', 'server']
		let conflicts = git(['merge-file', ...names, 'f', 'base', 'server']).code
		let view = git(['diff', '-c', '-U1', '--no-color', '--no-ext-diff', '--text', 'f']).out
		let rows = (hunks(view) ?? []).map((line) => (line.startsWith('@@') ? '…' : line))
		if (rows[0] === '…') rows.shift()
		return { text: readFileSync(`${dir}/f`, 'utf8'), conflicts, view: rows.join('\n') }
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

export const textDiff = { text, merge }
