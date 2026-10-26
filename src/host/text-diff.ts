// On-demand text diff generation, independent of its consumers (task k8y).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
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

// Runs `fn` with a private scratch directory holding `files`; `git`
// runs there, failing loudly unless `ok` accepts the exit code.
function scratch<T>(
	files: Record<string, string>,
	fn: (git: (args: string[], stdin?: string, ok?: (code: number) => boolean) => { out: string; code: number }) => T,
): T {
	let root = paths.tmpDir()
	mkdirSync(root, { recursive: true })
	let dir = mkdtempSync(`${root}/merge-`)
	try {
		for (let [name, text] of Object.entries(files)) writeFileSync(`${dir}/${name}`, text, { mode: 0o600 })
		return fn((args, stdin, ok = (code) => code === 0) => {
			let r = Bun.spawnSync(['git', '-C', dir, ...args], { stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin) })
			if (!ok(r.exitCode)) throw new Error(`git ${args[0]} failed (${r.exitCode}) at ${dir}:\n${r.stderr.toString()}`)
			return { out: r.stdout.toString(), code: r.exitCode }
		})
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

// A three-way merge of `ours` and `theirs` from `base`: the merged text,
// with conflict markers when `conflicts` (their count) is above 0.
function merge(base: string, ours: string, theirs: string): { text: string; conflicts: number } {
	return scratch({ base, ours, theirs }, (git) => {
		let r = git(
			['merge-file', '-p', '-L', 'local', '-L', 'base', '-L', 'server', 'ours', 'base', 'theirs'],
			undefined,
			(code) => code >= 0 && code < 128,
		)
		return { text: r.out, conflicts: r.code }
	})
}

// Git's combined diff (git diff -c) of `result` against `ours` (first
// column) and `theirs` (second): what each side gains and loses.
function combined(result: string, ours: string, theirs: string): string {
	return scratch({ f: result, ours, theirs }, (git) => {
		git(['init', '-q'])
		// The two sides as merge stages 2 and 3 of f, so git diff compares f with both.
		let ids = git(['hash-object', '-w', 'ours', 'theirs']).out.trim().split('\n')
		git(['update-index', '--index-info'], ids.map((id, i) => `100644 ${id} ${i + 2}\tf\n`).join(''))
		let view = git(['diff', '-c', '-U1', '--no-color', '--no-ext-diff', '--text', 'f']).out
		let rows = (hunks(view) ?? []).map((line) => (line.startsWith('@@') ? '…' : line))
		if (rows[0] === '…') rows.shift()
		return rows.join('\n')
	})
}

export const textDiff = { text, merge, combined }
