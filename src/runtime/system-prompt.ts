// System prompt — loads SYSTEM.md + AGENTS.md chain, substitutes variables, processes directives.

import { existsSync, readFileSync } from 'fs'
import { dirname, relative } from 'path'
import { config } from '../config.ts'
import { HAL_DIR, LAUNCH_CWD } from '../state.ts'

/** ::: if key="glob" ... ::: conditional blocks. */
function directives(text: string, vars: Record<string, string>): string {
	const lines = text.split('\n')
	const out: string[] = []
	let skip = false
	for (const line of lines) {
		const open = line.match(/^:{3,}\s+if\s+(\w+)="([^"]+)"\s*$/)
		if (open) {
			const val = vars[open[1]] ?? ''
			const re = new RegExp('^' + open[2].replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
			skip = !re.test(val)
			continue
		}
		if (/^:{3,}\s*$/.test(line)) { skip = false; continue }
		if (!skip) out.push(line)
	}
	return out.join('\n')
}

export interface LoadedFile {
	name: string   // 'SYSTEM.md' or 'AGENTS.md'
	path: string   // full filesystem path
	bytes: number  // raw file size
}

export interface SystemPromptResult {
	text: string
	loaded: LoadedFile[]
	bytes: number  // total byte size of processed result
}

/** Walk up from `from` to find the nearest .git directory. */
function findGitRoot(from: string): string | null {
	let dir = from
	for (;;) {
		if (existsSync(`${dir}/.git`)) return dir
		const parent = dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}

/** Collect all AGENTS.md (or CLAUDE.md fallback) files from git root down to cwd. */
function collectAgentFiles(cwd: string): { path: string; name: string; content: string; bytes: number }[] {
	const root = findGitRoot(cwd)
	const start = root ?? cwd
	// Build dir list from start → cwd
	const dirs: string[] = [start]
	if (start !== cwd) {
		const parts = relative(start, cwd).split('/').filter(Boolean)
		let cur = start
		for (const part of parts) {
			cur = `${cur}/${part}`
			dirs.push(cur)
		}
	}
	const results: { path: string; name: string; content: string; bytes: number }[] = []
	for (const dir of dirs) {
		// Prefer AGENTS.md; fall back to CLAUDE.md
		for (const name of ['AGENTS.md', 'CLAUDE.md']) {
			try {
				const p = `${dir}/${name}`
				const content = readFileSync(p, 'utf-8')
				results.push({ path: p, name, content, bytes: Buffer.byteLength(content) })
				break
			} catch {}
		}
	}
	return results
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`
	return `${(n / 1024).toFixed(1)}KB`
}

export function loadSystemPrompt(opts: { model?: string; sessionDir?: string; cwd?: string } = {}): SystemPromptResult {
	const model = opts.model ?? ''
	const cwd = opts.cwd ?? LAUNCH_CWD
	const cfg = config.getConfig()
	const d = new Date()
	const date = `${d.toISOString().slice(0, 10)}, ${d.toLocaleDateString('en-US', { weekday: 'long' })}`

	const vars: Record<string, string> = {
		model, date, cwd, hal_dir: HAL_DIR, session_dir: opts.sessionDir ?? '',
		eval: cfg.eval ? 'true' : 'false',
	}
	const sub = (s: string) => s
		.replace(/\$\{model\}/g, model).replace(/\$\{cwd\}/g, cwd)
		.replace(/\$\{date\}/g, date).replace(/\$\{hal_dir\}/g, HAL_DIR)
		.replace(/\$\{session_dir\}/g, opts.sessionDir ?? '')

	const parts: string[] = []
	const loaded: LoadedFile[] = []
	try {
		let text = readFileSync(`${HAL_DIR}/SYSTEM.md`, 'utf-8')
		const bytes = Buffer.byteLength(text)
		text = text.replace(/<!--[\s\S]*?-->/g, '')
		parts.push(text)
		loaded.push({ name: 'SYSTEM.md', path: `${HAL_DIR}/SYSTEM.md`, bytes })
	} catch {
		parts.push('You are a helpful coding assistant.')
	}

	// Walk git root → cwd collecting AGENTS.md (or CLAUDE.md fallback) files
	for (const agent of collectAgentFiles(cwd)) {
		parts.push(agent.content)
		loaded.push({ name: agent.name, path: agent.path, bytes: agent.bytes })
	}

	const text = parts
		.map(p => directives(p, vars))
		.map(sub)
		.join('\n\n')
		.replace(/\n{3,}/g, '\n\n')
	return { text, loaded, bytes: Buffer.byteLength(text) }
}

export const systemPrompt = { loadSystemPrompt, formatBytes, collectAgentFiles, findGitRoot }