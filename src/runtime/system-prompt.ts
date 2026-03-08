// System prompt — loads SYSTEM.md + AGENTS.md, substitutes variables, processes directives.

import { readFileSync } from 'fs'
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

export function loadSystemPrompt(opts: { model?: string; sessionDir?: string } = {}): string {
	const model = opts.model ?? ''
	const d = new Date()
	const date = `${d.toISOString().slice(0, 10)}, ${d.toLocaleDateString('en-US', { weekday: 'long' })}`

	const vars: Record<string, string> = {
		model, date, cwd: LAUNCH_CWD, hal_dir: HAL_DIR, session_dir: opts.sessionDir ?? '',
	}
	const sub = (s: string) => s
		.replace(/\$\{model\}/g, model).replace(/\$\{cwd\}/g, LAUNCH_CWD)
		.replace(/\$\{date\}/g, date).replace(/\$\{hal_dir\}/g, HAL_DIR)
		.replace(/\$\{session_dir\}/g, opts.sessionDir ?? '')

	const parts: string[] = []
	try {
		let text = readFileSync(`${HAL_DIR}/SYSTEM.md`, 'utf-8')
		text = text.replace(/<!--[\s\S]*?-->/g, '')
		parts.push(text)
	} catch {
		parts.push('You are a helpful coding assistant.')
	}
	try { parts.push(readFileSync(`${LAUNCH_CWD}/AGENTS.md`, 'utf-8')) } catch {}

	return parts
		.map(p => directives(p, vars))
		.map(sub)
		.join('\n\n')
		.replace(/\n{3,}/g, '\n\n')
}
