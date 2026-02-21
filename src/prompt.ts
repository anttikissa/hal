import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { HAL_DIR } from './state.ts'

function processModelTags(text: string, model: string): string {
	return text.replace(
		/<if\s+model="([^"]+)">\s*([\s\S]*?)\s*<\/if>/g,
		(_match, pattern: string, body: string) => {
			const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
			return regex.test(model) ? body : ''
		},
	)
}

export interface SystemPromptResult {
	blocks: any[]
	systemBytes: number
	loaded: string[]
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

	const processed = parts
		.map((p) => processModelTags(p, model))
		.map((p) =>
			p
				.replace(/\$\{model\}/g, model)
				.replace(/\$\{cwd\}/g, workingDir)
				.replace(/\$\{date\}/g, today)
				.replace(/\$\{session_dir\}/g, sessDir),
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

	return { blocks, systemBytes, loaded }
}
