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
		let result = Bun.spawnSync(['git', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--text', '-U1', '--', `${dir}/a`, `${dir}/b`])
		if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(`git diff failed (${result.exitCode}) at ${dir}:\n${result.stderr.toString()}${result.stdout.toString()}`)
		// Strip file headers only, not content lines beginning with --- or +++.
		let lines = result.stdout.toString().split('\n'), start = lines.findIndex((line) => line.startsWith('@@'))
		if (start < 0) return result.stdout.toString().trimEnd()
		lines = lines.slice(start).filter((line) => line !== '')
		if (numbered) {
			let width = String(Math.max(before.split('\n').length, after.split('\n').length)).length, old = 0, now = 0
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
		} else lines = lines.map((line) => line.startsWith('@@') ? '…' : line)
		if (lines[0] === '…') lines.shift()
		let more = lines.length - limit
		return [...lines.slice(0, limit), ...(more > 0 ? [`… ${more} more lines`] : [])].join('\n')
	} finally { rmSync(dir, { recursive: true, force: true }) }
}
export const textDiff = { text }
