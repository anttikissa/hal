import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { HAL_DIR } from './state.ts'

/**
 * Process fenced directives in the system prompt.
 *
 * Uses Pandoc-style colon-fenced syntax (not part of CommonMark, but widely
 * adopted by Pandoc fenced_divs and MyST Markdown). Editors treat `:::` as
 * inert text, unlike `<if>` which Markdown parsers treat as inline HTML.
 *
 *   ::: if model="<glob>"
 *   content included when the model matches
 *   :::
 *
 * The glob supports `*` (any chars) and `?` (single char).
 * Nesting is not supported — directives cannot be placed inside other directives.
 *
 * References:
 *   - Pandoc fenced divs: https://pandoc.org/demo/example33/8.18-divs-and-spans.html
 *   - MyST directives:    https://mystmd.org/guide/syntax-overview
 */
function processDirectives(text: string, vars: Record<string, string>): string {
	const lines = text.split('\n')
	const result: string[] = []
	let inFence = false
	let fenceLine = 0
	let accept = true

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]

		// Opening fence: 3+ colons, then "if key="pattern""
		const openMatch = line.match(/^:{3,}\s+if\s+(\w+)="([^"]+)"\s*$/)
		if (openMatch) {
			if (inFence)
				throw new Error(
					`nested ::: if at line ${i + 1} (outer opened at line ${fenceLine})`,
				)
			inFence = true
			fenceLine = i + 1
			const value = vars[openMatch[1]] ?? ''
			const regex = new RegExp(
				'^' + openMatch[2].replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
			)
			accept = regex.test(value)
			continue
		}

		// Closing fence: 3+ colons on a line by itself
		if (/^:{3,}\s*$/.test(line)) {
			if (!inFence) throw new Error(`unexpected ::: at line ${i + 1} (no matching opener)`)
			inFence = false
			accept = true
			continue
		}

		if (accept) result.push(line)
	}

	if (inFence) throw new Error(`unclosed ::: if opened at line ${fenceLine}`)

	return result.join('\n')
}

export interface SystemPromptResult {
	blocks: any[]
	systemBytes: number
	loaded: string[]
	warnings: string[]
}

export async function loadSystemPrompt(
	options: {
		model?: string
		halDir?: string
		workingDir?: string
		sessionDir?: string
	} = {},
): Promise<SystemPromptResult> {
	const model = options.model ?? ''
	const halDir = resolve(options.halDir ?? HAL_DIR)
	const workingDir = resolve(options.workingDir ?? halDir)
	const sessDir = options.sessionDir ?? ''
	const parts: string[] = []
	const loaded: string[] = []

	try {
		let text = await readFile(`${halDir}/SYSTEM.md`, 'utf-8')
		text = text.replace(/<!--[\s\S]*?-->/g, '')
		parts.push(text)
		loaded.push('SYSTEM.md')
	} catch {
		parts.push('You are a helpful coding assistant.')
	}

	try {
		const agents = await readFile(`${workingDir}/AGENTS.md`, 'utf-8')
		parts.push(agents)
		loaded.push(workingDir !== halDir ? `AGENTS.md (${workingDir})` : 'AGENTS.md')
	} catch {
		// No AGENTS.md
	}

	const d = new Date()
	const iso = d.toISOString().slice(0, 10)
	const weekday = d.toLocaleDateString('en-US', { weekday: 'long' })
	const today = `${iso}, ${weekday}`

	const vars: Record<string, string> = {
		model,
		cwd: workingDir,
		date: today,
		session_dir: sessDir,
		hal_dir: halDir,
	}

	const warnings: string[] = []
	const processed = parts
		.map((p, i) => {
			try {
				return processDirectives(p, vars)
			} catch (e: any) {
				warnings.push(`${loaded[i] ?? 'unknown'}: ${e.message}`)
				return p // fall back to raw text
			}
		})
		.map((p) =>
			p
				.replace(/\$\{model\}/g, model)
				.replace(/\$\{cwd\}/g, workingDir)
				.replace(/\$\{date\}/g, today)
				.replace(/\$\{session_dir\}/g, sessDir)
				.replace(/\$\{hal_dir\}/g, halDir),
		)
		.map((p) => p.replace(/\n{3,}/g, '\n\n'))

	const blocks = processed
		.filter((text) => text.trim().length > 0)
		.map((text, i, arr) => {
			const block: any = { type: 'text', text }
			if (i === arr.length - 1) block.cache_control = { type: 'ephemeral' }
			return block
		})

	let systemBytes = 0
	for (const block of blocks) systemBytes += block.text?.length ?? 0

	return { blocks, systemBytes, loaded, warnings }
}
