// READ: local images, versioned text with numbered lines (task 3fv),
// directory listings and URLs.

import { readdirSync, realpathSync, statSync } from 'fs'
import { paths } from '../paths.ts'
import { resolve } from 'path'
import { attachments } from '../../common/attachments.ts'
import { callText } from '../../common/call-text.ts'
import { settings } from '../../common/settings.ts'
import { approval } from '../approval.ts'
import { blobs } from '../blobs.ts'
import { fileText } from '../file-text.ts'
import { type Tool, type ToolOutput, tools } from '../tools.ts'
import { webRead } from '../web-read.ts'

function count(input: Record<string, unknown>, key: string, min: number): number | undefined {
	let v = input[key]
	if (v === undefined) return undefined
	if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new Error(`${key} must be an integer of at least ${min}`)
	return v
}

// READ "path" (the first tools.readLines lines), "path:10" (line 10),
// "path:10-20", "path:1-" (to the end); an http(s) URL is fetched (web-read.ts).
// Several paths retain each file's version, ranges and images.
function resolveCall(raw: string): { name: string; input: Record<string, unknown> } {
	let { values } = callText.values(raw)
	if (values.length > 1 && values.every((v) => typeof v === 'string' && v)) return { name: 'read', input: { paths: values.map((v) => /^https?:\/\//i.test(v as string) ? { url: v } : one(v as string).input) } }
	let [path] = values
	if (values.length !== 1 || typeof path !== 'string' || !path) throw new Error(`READ takes one path or several paths, e.g. READ "a.ts:1-100" "b.ts:1-100"; got ${values.length} arguments`)
	return one(path)
}

function one(path: string): { name: string; input: Record<string, unknown> } {
	if (/^https?:\/\//i.test(path)) return { name: 'read', input: { url: path } }
	let m = /:(\d+)(?:(-)(\d+)?)?$/.exec(path)
	if (!m) return { name: 'read', input: { path } }
	let start = Number(m[1]), end = m[2] ? (m[3] === undefined ? undefined : Number(m[3])) : start
	let offset = Math.max(1, start)
	return { name: 'read', input: { path: path.slice(0, m.index), offset, ...(end !== undefined && { limit: Math.max(0, end - offset + 1) }) } }
}

export const tool: Tool<ToolOutput> = {
	name: 'read',
	description:
		'Read files, images, directories, or URLs; multiple paths are accepted. Relative paths start from cwd. ' +
		'Text results start with == path@version ==, followed by numbered lines. EDIT requires that version. ' +
		'Ranges are 1-based and inclusive. Default: first 200 lines; path:1- reads all. ' +
		'Images attach directly; URLs return readable text or save other files under /tmp. Sensitive local paths are refused in best-effort mode.',
	syntax: {
		summary: false,
		usage: ['READ "<path>[:<start>[-<end>]]" ...   // one or more; :5 reads line 5, :5- to the end', 'READ "<url>"'],
		resolve: resolveCall,
	},
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File or directory path' },
			offset: { type: 'integer', minimum: 1, description: 'First line, 1-based: the :start of READ "path:start-end"' },
			limit: { type: 'integer', minimum: 0, description: 'Number of lines: from :start-end' },
		},
		required: ['path'],
	},
	async run(input, ctx) {
		if (Array.isArray(input.paths)) {
			let parts: string[] = [], errors: string[] = []
			let images: { mediaType: string; data: string; source?: string }[] = []
			for (let p of input.paths) {
				try {
					let item = p as Record<string, unknown>
					let out = await (item.url !== undefined ? webRead : tool).run(item, ctx)
					let attached = typeof out === 'string' ? [] : [...(out.image ? [out.image] : []), ...(out.images ?? [])]
					images.push(...attached.map((image) => ({ ...image, source: String(item.path ?? item.url) })))
					if (typeof out !== 'string' && out.isError) errors.push(`== READ ${item.path ?? item.url} ==\n${out.text}`)
					else parts.push(typeof out === 'string' ? out : out.text)
				} catch (e: any) {
					errors.push(`== READ ${(p as { path?: string; url?: string })?.path ?? (p as { url?: string })?.url}: ${e?.message ?? e} ==`)
				}
			}
			let text = [...errors, ...parts].join('\n\n')
			return images.length || errors.length ? { text, images, ...(errors.length && { isError: true }) } : text
		}
		if (typeof input.url === 'string') return webRead.run(input, ctx)
		if (typeof input.path !== 'string' || !input.path) throw new Error('path must be a non-empty string')
		let offset = count(input, 'offset', 1)
		let limit = count(input, 'limit', 0)
		let path = resolve(ctx.cwd, paths.expand(input.path))
		if (settings.security() !== 'none' && (approval.sensitive(path) || approval.sensitive(realpathSync(path)))) throw new Error(`${input.path} is a sensitive path; READ refused to expose secrets`)
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
		let capped = offset === undefined && limit === undefined
		return fileText.read(input.path, bytes, offset, capped ? tools.readLines : limit, capped)
	},
}
