// Resolve [file.png] and [file.txt] references in user input into content blocks.

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { blob } from './blob.ts'
import type { UserMessage } from './history.ts'

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp']

const MEDIA_TYPES: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	png: 'image/png',
}

async function resolve(
	sessionId: string,
	input: string,
): Promise<{ apiContent: any; logContent: UserMessage['content'] }> {
	const pattern = /\[([^\]]+\.(png|jpg|jpeg|gif|webp|txt))\]/gi
	const allMatches = [...input.matchAll(pattern)]
	const matches = allMatches.filter(m => {
		const ext = m[2].toLowerCase()
		return ext !== 'txt' || m[1].startsWith('/tmp/hal/')
	})
	if (matches.length === 0) return { apiContent: input, logContent: input }
	const apiBlocks: any[] = []
	const logBlocks: any[] = []
	let lastIndex = 0
	for (const match of matches) {
		const filePath = match[1].startsWith('~') ? match[1].replace('~', homedir()) : match[1]
		const ext = match[2].toLowerCase()
		const before = input.slice(lastIndex, match.index)
		if (before.trim()) {
			apiBlocks.push({ type: 'text', text: before })
			logBlocks.push({ type: 'text', text: before })
		}
		if (!existsSync(filePath)) {
			apiBlocks.push({ type: 'text', text: `[file not found: ${filePath}]` })
			logBlocks.push({ type: 'text', text: `[file not found: ${filePath}]` })
		} else if (ext === 'txt') {
			try {
				const text = readFileSync(filePath, 'utf8')
				apiBlocks.push({ type: 'text', text })
				logBlocks.push({ type: 'text', text: `[${filePath}]` })
			} catch {
				apiBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
				logBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
			}
		} else if (IMAGE_EXTS.includes(ext)) {
			try {
				const data = readFileSync(filePath)
				const mediaType = MEDIA_TYPES[ext] ?? 'image/png'
				const blobId = blob.makeId(sessionId)
				await blob.write(sessionId, blobId, { media_type: mediaType, data: data.toString('base64') })
				apiBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } })
				logBlocks.push({ type: 'image', blobId, originalFile: filePath })
			} catch {
				apiBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
				logBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
			}
		}
		lastIndex = match.index! + match[0].length
	}
	const after = input.slice(lastIndex)
	if (after.trim()) {
		apiBlocks.push({ type: 'text', text: after })
		logBlocks.push({ type: 'text', text: after })
	}
	return { apiContent: apiBlocks, logContent: logBlocks as UserMessage['content'] }
}

export const attachments = { resolve }
