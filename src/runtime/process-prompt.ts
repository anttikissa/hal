import { existsSync, readFileSync } from 'fs'
import { loadConfig, resolveModel, providerForModel } from '../config.ts'
import { getProvider } from '../provider.ts'
import { logPrompt } from '../session.ts'
import { getOrLoadSessionRuntime } from './sessions.ts'
import { runAgentLoop } from './agent-loop.ts'

// Parse inline image/file references: [path/to/file.png]
function parseInputContent(input: string): any {
	const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp']
	const filePattern = /\[([^\]]+\.(png|jpg|jpeg|gif|webp|txt))\]/gi
	const matches = [...input.matchAll(filePattern)]
	if (matches.length === 0) return input

	const blocks: any[] = []
	let lastIndex = 0

	for (const match of matches) {
		const filePath = match[1]
		const ext = match[2].toLowerCase()
		const before = input.slice(lastIndex, match.index)
		if (before.trim()) blocks.push({ type: 'text', text: before })

		if (existsSync(filePath)) {
			try {
				if (IMAGE_EXTS.includes(ext)) {
					const data = readFileSync(filePath)
					const mediaType =
						ext === 'jpg' || ext === 'jpeg'
							? 'image/jpeg'
							: ext === 'gif'
								? 'image/gif'
								: ext === 'webp'
									? 'image/webp'
									: 'image/png'
					blocks.push({
						type: 'image',
						source: {
							type: 'base64',
							media_type: mediaType,
							data: data.toString('base64'),
						},
					})
				} else {
					blocks.push({ type: 'text', text: readFileSync(filePath, 'utf8') })
				}
			} catch {
				blocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
			}
		} else {
			blocks.push({ type: 'text', text: `[file not found: ${filePath}]` })
		}
		lastIndex = match.index! + match[0].length
	}

	const after = input.slice(lastIndex)
	if (after.trim()) blocks.push({ type: 'text', text: after })

	return blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks
}

export async function processPrompt(sessionId: string, input: string): Promise<void> {
	const runtime = await getOrLoadSessionRuntime(sessionId)
	const config = loadConfig()
	const fullModel = resolveModel(config.model)
	const providerName = providerForModel(fullModel)

	await logPrompt(sessionId, {
		timestamp: new Date().toISOString(),
		model: fullModel,
		provider: providerName,
		prompt: input,
	})

	runtime.messages.push({ role: 'user', content: parseInputContent(input) })

	const provider = getProvider(providerName)
	await provider.refreshAuth()

	await runAgentLoop(sessionId, runtime)
}
