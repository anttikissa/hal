// Expand [file.ext] references in user input into API content blocks.
// History keeps lightweight refs instead of raw image payloads.

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { blob } from './blob.ts'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

const MEDIA_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
}

const ATTACHMENT_RE = /\[([^\]]+\.(png|jpg|jpeg|gif|webp|txt|md|json))\]/gi

export interface ResolvedAttachment {
	apiContent: string | any[]
	logParts: Array<{ type: 'text'; text: string } | { type: 'image'; blobId: string; originalFile?: string }>
}

async function resolve(sessionId: string, input: string): Promise<ResolvedAttachment> {
	const matches = [...input.matchAll(ATTACHMENT_RE)]
	// Plain .txt reads stay limited to Hal-owned temp files so prompts cannot smuggle in arbitrary local text.
	const valid = matches.filter((match) => {
		const ext = match[2]!.toLowerCase()
		return ext !== 'txt' || match[1]!.startsWith('/tmp/hal/')
	})

	if (valid.length === 0) return { apiContent: input, logParts: [{ type: 'text', text: input }] }

	const apiBlocks: any[] = []
	const logParts: ResolvedAttachment['logParts'] = []
	let lastIndex = 0

	for (const match of valid) {
		const filePath = match[1]!.startsWith('~') ? match[1]!.replace('~', homedir()) : match[1]!
		const ext = match[2]!.toLowerCase()
		const before = input.slice(lastIndex, match.index)

		if (before.trim()) {
			apiBlocks.push({ type: 'text', text: before })
			logParts.push({ type: 'text', text: before })
		}

		if (!existsSync(filePath)) {
			apiBlocks.push({ type: 'text', text: `[file not found: ${filePath}]` })
			logParts.push({ type: 'text', text: `[file not found: ${filePath}]` })
		} else if (IMAGE_EXTS.has(ext)) {
			try {
				const data = readFileSync(filePath)
				const mediaType = MEDIA_TYPES[ext] ?? 'image/png'
				const b64 = data.toString('base64')
				const blobId = blob.makeBlobId(sessionId)
				await blob.writeBlob(sessionId, blobId, { media_type: mediaType, data: b64 })
				apiBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } })
				logParts.push({ type: 'image', blobId, originalFile: filePath })
			} catch {
				apiBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
				logParts.push({ type: 'text', text: `[failed to read: ${filePath}]` })
			}
		} else {
			try {
				const text = readFileSync(filePath, 'utf-8')
				apiBlocks.push({ type: 'text', text })
				logParts.push({ type: 'text', text: `[${filePath}]` })
			} catch {
				apiBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
				logParts.push({ type: 'text', text: `[failed to read: ${filePath}]` })
			}
		}

		lastIndex = match.index! + match[0].length
	}

	const after = input.slice(lastIndex)
	if (after.trim()) {
		apiBlocks.push({ type: 'text', text: after })
		logParts.push({ type: 'text', text: after })
	}

	return { apiContent: apiBlocks, logParts }
}

export const attachments = { resolve }
