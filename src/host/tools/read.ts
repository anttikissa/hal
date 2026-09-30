// read: a local image, a text file in pages, or a directory listing.

import { readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
import { attachments } from '../../common/attachments.ts'
import { blobs } from '../blobs.ts'
import { type Tool, type ToolOutput, tools } from '../tools.ts'

function positive(input: Record<string, unknown>, key: string): number | undefined {
	let v = input[key]
	if (v === undefined) return undefined
	if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`${key} must be a positive integer`)
	return v
}

export const tool: Tool<ToolOutput> = {
	name: 'read',
	description:
		'Read a text file or image, or list a directory. Images are attached directly. Relative paths start from the working directory. ' +
		'Long files come in pages; use offset (first line, 1-based) and limit (number of lines) to read on.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File or directory path' },
			offset: { type: 'integer', minimum: 1 },
			limit: { type: 'integer', minimum: 1 },
		},
		required: ['path'],
	},
	readOnly: true,
	async run(input, ctx) {
		if (typeof input.path !== 'string' || !input.path) throw new Error('path must be a non-empty string')
		let offset = positive(input, 'offset')
		let limit = positive(input, 'limit')
		let path = resolve(ctx.cwd, input.path.replace(/^~(?=\/|$)/, homedir()))
		let st = statSync(path)
		if (st.isDirectory()) {
			let entries = readdirSync(path, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
			return tools.page(entries.sort().map((e) => `${e}\n`).join(''), offset, limit)
		}
		let file = Bun.file(path)
		let head = await file.slice(0, 12).bytes()
		let mediaType = Object.keys(attachments.types).find((type) => type.startsWith('image/') && blobs.looksLike(type, head))
		let max = mediaType ? attachments.maxBytes() : tools.maxFileBytes()
		if (st.size > max) throw new Error(`${input.path} is too large to read (${st.size} bytes)`)
		let bytes = await file.slice(0, max + 1).bytes()
		if (bytes.length > max) throw new Error(`${input.path} is too large to read (${bytes.length} bytes)`)
		if (mediaType) {
			return { text: `Image from ${path} (${mediaType}, ${bytes.length} bytes)`, image: { mediaType, data: Buffer.from(bytes).toString('base64') } }
		}
		if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${input.path} looks like a binary file`)
		return tools.page(new TextDecoder().decode(bytes), offset, limit)
	},
}
