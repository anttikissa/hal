// Attachments — resolve [file.png] and [file.txt] references in user input.
//
// When a user types "[screenshot.png]" or "[notes.txt]" in their prompt, this
// module reads the file and converts it into content blocks for the API:
// - Images: base64-encoded, stored as blobs for history persistence
// - Text files: inlined as text blocks
//
// Pattern: [/path/to/file.ext] — only recognized extensions are expanded.

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { blob } from './blob.ts'

// Supported image extensions and their MIME types
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

const MEDIA_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
}

// Match [path.ext] patterns for supported file types
const ATTACHMENT_RE = /\[([^\]]+\.(png|jpg|jpeg|gif|webp|txt|md|json))\]/gi

export interface ResolvedAttachment {
	// Content blocks for the API call (images as base64, text inlined)
	apiContent: string | any[]
	// Content for history logging (images as blob references, text as placeholders)
	logContent: string | any[]
}

// Resolve attachment references in user input text.
// Returns separate API and log content — API gets the full data, history log
// gets lightweight blob references to avoid bloating the ASONL file.
async function resolve(sessionId: string, input: string): Promise<ResolvedAttachment> {
	const matches = [...input.matchAll(ATTACHMENT_RE)]
	// Only process txt files if they're from known safe paths
	const valid = matches.filter((m) => {
		const ext = m[2]!.toLowerCase()
		return ext !== 'txt' || m[1]!.startsWith('/tmp/hal/')
	})

	if (valid.length === 0) return { apiContent: input, logContent: input }

	const apiBlocks: any[] = []
	const logBlocks: any[] = []
	let lastIndex = 0

	for (const match of valid) {
		const filePath = match[1]!.startsWith('~') ? match[1]!.replace('~', homedir()) : match[1]!
		const ext = match[2]!.toLowerCase()
		const before = input.slice(lastIndex, match.index)

		// Text before the attachment reference
		if (before.trim()) {
			apiBlocks.push({ type: 'text', text: before })
			logBlocks.push({ type: 'text', text: before })
		}

		if (!existsSync(filePath!)) {
			apiBlocks.push({ type: 'text', text: `[file not found: ${filePath}]` })
			logBlocks.push({ type: 'text', text: `[file not found: ${filePath}]` })
		} else if (IMAGE_EXTS.has(ext)) {
			// Image: read, base64 encode, store as blob
			try {
				const data = readFileSync(filePath)
				const mediaType = MEDIA_TYPES[ext] ?? 'image/png'
				const b64 = data.toString('base64')
				const blobId = blob.makeBlobId(sessionId)
				await blob.writeBlob(sessionId, blobId, { media_type: mediaType, data: b64 })
				apiBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } })
				logBlocks.push({ type: 'image', blobId, originalFile: filePath })
			} catch {
				apiBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
				logBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
			}
		} else {
			// Text file: inline the content
			try {
				const text = readFileSync(filePath, 'utf-8')
				apiBlocks.push({ type: 'text', text })
				logBlocks.push({ type: 'text', text: `[${filePath}]` })
			} catch {
				apiBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
				logBlocks.push({ type: 'text', text: `[failed to read: ${filePath}]` })
			}
		}

		lastIndex = match.index! + match[0].length
	}

	// Text after the last attachment
	const after = input.slice(lastIndex)
	if (after.trim()) {
		apiBlocks.push({ type: 'text', text: after })
		logBlocks.push({ type: 'text', text: after })
	}

	return { apiContent: apiBlocks, logContent: logBlocks }
}

export const attachments = { resolve }
