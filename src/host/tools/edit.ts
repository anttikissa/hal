// edit: changes line ranges of one leased version of a text file (task
// aks). Every range refers to the version READ showed as path@hash; all
// apply at once, or none. The host-wide file lock (file-changes.ts)
// serializes Hal's own edits of a file, and the bytes are compared
// again just before the atomic rename, so an outside change in between
// fails rather than being overwritten. The change is recorded like a
// bash call's declared files.

import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { action } from '../../common/action.ts'
import { fileChanges } from '../file-changes.ts'
import { type Change, lease } from '../lease.ts'
import { type Tool, tools } from '../tools.ts'

const usage = 'EDIT [/* purpose */] "<path>@<hash>" { range: "<start>-<end>", lines: ["...", ...] } [{ range, lines } ...]'

function changes(value: unknown): Change[] {
	if (!Array.isArray(value) || !value.length) throw new Error(`edits must be a non-empty list of { range, lines }. Usage: ${usage}`)
	return value.map((e, i) => {
		if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`edit ${i + 1} must be { range, lines }. Usage: ${usage}`)
		let extra = Object.keys(e).filter((k) => k !== 'range' && k !== 'lines')
		if (extra.length) throw new Error(`edit ${i + 1} has unknown field ${extra.join(', ')}; only range and lines. Usage: ${usage}`)
		let { range, lines } = e as Record<string, unknown>
		if (!Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) throw new Error(`edit ${i + 1}: lines must be a list of strings (lines: [] deletes the range). Usage: ${usage}`)
		try {
			return { ...lease.range(range), lines }
		} catch (err: any) {
			throw new Error(`edit ${i + 1}: ${err.message}`)
		}
	})
}

export const tool: Tool = {
	name: 'edit',
	description:
		'Replace line ranges of a text file, all at once. Name the lease path@hash from READ; when the file has changed since, nothing is written and the lines now around each range are shown. ' +
		'Ranges are 1-based, inclusive, and all refer to the leased version; they may not overlap. lines replaces the range, one string per line; lines: [] deletes it. ' +
		'A start past the end appends. The result is the new lease and the lines around each change, numbered as in the new file.',
	action: {
		summary: false,
		usage: [usage],
		fields: { lease: 'path@hash from READ', edits: 'The { range, lines } objects after the lease', description: 'Set by a /* purpose */ comment' },
		resolve(raw) {
			let { values, purpose, unclosed } = action.values(raw)
			let [named, ...edits] = values
			let cut = unclosed ? ' (an unclosed /* comment ran to its line end; close it with */)' : ''
			if (typeof named !== 'string' || !named.includes('@')) throw new Error(`EDIT starts with the lease from READ, "path@hash"${cut}. Usage: ${usage}`)
			if (!edits.length) throw new Error(`EDIT is missing its { range, lines } objects${cut}. Usage: ${usage}`)
			let at = named.lastIndexOf('@')
			return { name: 'edit', input: { path: named.slice(0, at), hash: named.slice(at + 1).toLowerCase(), edits, ...(purpose && { description: purpose }) } }
		},
	},
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path, relative to the working directory or under /tmp' },
			hash: { type: 'string', description: 'The lease hash READ showed after @' },
			edits: { type: 'array', items: { type: 'object' }, description: 'Changes: { range: "start-end", lines: [...] }' },
			description: { type: 'string', description: 'What the edit does, for the user' },
		},
		required: ['path', 'hash', 'edits'],
	},
	async run(input, ctx) {
		if (typeof input.path !== 'string' || !input.path) throw new Error(`path must be a non-empty string. Usage: ${usage}`)
		if (typeof input.hash !== 'string') throw new Error(`hash must be the lease hash from READ. Usage: ${usage}`)
		let wanted = changes(input.edits)
		let path = input.path
		let observation = await fileChanges.begin(ctx, fileChanges.validate([path]))
		try {
			let full = resolve(ctx.cwd, path)
			let bytes = await readFile(full)
			if (bytes.length > tools.maxFileBytes) throw new Error(`${path} is too large to edit (${bytes.length} bytes)`)
			let now = lease.hash(bytes)
			let current = lease.text(bytes, path)
			let ranges = wanted.map((c) => (c.start === c.end ? `${c.start}` : `${c.start}-${c.end}`)).join(',')
			if (now !== input.hash) throw new Error(`== EDIT ${path}@${now}:${ranges} failed (file has been modified since @${input.hash}) ==\n${lease.around(current, wanted)}`)
			let { after, shown, lines } = lease.apply(current, wanted)
			let next = Buffer.from(after)
			if (next.equals(bytes)) return `== EDIT ${path}@${now} unchanged: the lines already read so; nothing written ==`
			if (ctx.signal.aborted) throw new Error('stopped before writing; nothing was written')
			await lease.commit(full, next, bytes)
			return `== EDIT ${path}@${lease.hash(next)} ok: ==\n${lease.numbered(lines, shown) || '[Empty file]'}`
		} finally {
			await fileChanges.finish(observation)
		}
	},
}
