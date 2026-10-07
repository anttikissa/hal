// On-demand text diff generation, independent of its consumers (task k8y).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { paths } from './paths.ts'

function text(before: string, after: string, limit = Infinity): string {
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
		lines = lines.slice(start).filter((line) => line !== '').map((line) => line.startsWith('@@') ? '…' : line)
		if (lines[0] === '…') lines.shift()
		let more = lines.length - limit
		return [...lines.slice(0, limit), ...(more > 0 ? [`… ${more} more lines`] : [])].join('\n')
	} finally { rmSync(dir, { recursive: true, force: true }) }
}
export const textDiff = { text }
