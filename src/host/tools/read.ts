// read: a local image, a text file as numbered lines under its editing
// lease (lease.ts, task 3fv), or a directory listing.

import { readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
import { attachments } from '../../common/attachments.ts'
import { action } from '../../common/action.ts'
import { blobs } from '../blobs.ts'
import { lease } from '../lease.ts'
import { type Tool, type ToolOutput, tools } from '../tools.ts'

function count(input: Record<string, unknown>, key: string, min: number): number | undefined {
	let v = input[key]
	if (v === undefined) return undefined
	if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new Error(`${key} must be an integer of at least ${min}`)
	return v
}

// READ "path", READ "path:10" (line 10), "path:10-20", "path:10-" (to
// the end); an http(s) URL reads through read_url.
function resolveAction(raw: string): { name: string; input: Record<string, unknown> } {
	let { values } = action.values(raw)
	let [path] = values
	if (values.length !== 1 || typeof path !== 'string' || !path) throw new Error(`READ takes one path, e.g. READ "src/main.ts:1-100"; got ${values.length} arguments`)
	if (/^https?:\/\//i.test(path)) return { name: 'read_url', input: { url: path } }
	let m = /:(\d+)(?:(-)(\d+)?)?$/.exec(path)
	if (!m) return { name: 'read', input: { path } }
	let start = Number(m[1]), end = m[2] ? (m[3] === undefined ? undefined : Number(m[3])) : start
	let offset = Math.max(1, start)
	return { name: 'read', input: { path: path.slice(0, m.index), offset, ...(end !== undefined && { limit: Math.max(0, end - offset + 1) }) } }
}

export const tool: Tool<ToolOutput> = {
	name: 'read',
	description:
		'Read a text file or image, or list a directory. Images are attached directly. Relative paths start from the working directory. ' +
		'A text file comes as numbered lines under its editing lease, == READ <path>@<hash> ==; the hash covers the whole file, even when a range is shown, and EDIT needs it. ' +
		'Ranges are 1-based and inclusive, clamped to the file; a range past the end shows [Empty range]. Long output stops with how to continue.',
	action: {
		summary: false,
		usage: ['READ "<path>"', 'READ "<path>:<start>-<end>"', 'READ "<path>:<start>-"', 'READ "<path>:<line>"', 'READ "<http(s) URL>"'],
		fields: { offset: 'First line, 1-based: the :start of READ "path:start-end"', limit: 'Number of lines: from :start-end' },
		resolve: resolveAction,
	},
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File or directory path' },
			offset: { type: 'integer', minimum: 1 },
			limit: { type: 'integer', minimum: 0 },
		},
		required: ['path'],
	},
	async run(input, ctx) {
		if (typeof input.path !== 'string' || !input.path) throw new Error('path must be a non-empty string')
		let offset = count(input, 'offset', 1)
		let limit = count(input, 'limit', 0)
		let path = resolve(ctx.cwd, input.path.replace(/^~(?=\/|$)/, homedir()))
		let st = statSync(path)
		if (st.isDirectory()) {
			let entries = readdirSync(path, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
			return tools.page(entries.sort().map((e) => `${e}\n`).join(''), offset, limit)
		}
		let file = Bun.file(path)
		let head = await file.slice(0, 12).bytes()
		let mediaType = Object.keys(attachments.types).find((type) => type.startsWith('image/') && blobs.looksLike(type, head))
		let max = mediaType ? attachments.maxBytes : tools.maxFileBytes
		if (st.size > max) throw new Error(`${input.path} is too large to read (${st.size} bytes)`)
		let bytes = await file.slice(0, max + 1).bytes()
		if (bytes.length > max) throw new Error(`${input.path} is too large to read (${bytes.length} bytes)`)
		if (mediaType) {
			return { text: `Image from ${path} (${mediaType}, ${bytes.length} bytes)`, image: { mediaType, data: Buffer.from(bytes).toString('base64') } }
		}
		if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${input.path} looks like a binary file`)
		return lease.read(input.path, bytes, offset, limit)
	},
}
