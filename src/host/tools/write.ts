// write: creates a file or replaces all of it (task 3fv), atomically,
// creating missing directories. Recorded like a bash call's declared
// files, under the same host-wide file lock.

import { mkdir } from 'fs/promises'
import { dirname, resolve } from 'path'
import { fileChanges } from '../file-changes.ts'
import { lease } from '../lease.ts'
import type { Tool } from '../tools.ts'

export const tool: Tool = {
	name: 'write',
	description: 'Create a file or replace its whole content, creating missing directories. Returns the new editing lease. For changes to part of a file, use EDIT.',
	action: { summary: false, usage: ['WRITE "<path>" "<content>"'] },
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
			content: { type: 'string', description: 'The whole new content' },
		},
		required: ['path', 'content'],
	},
	async run(input, ctx) {
		if (typeof input.path !== 'string' || !input.path) throw new Error('path must be a non-empty string')
		if (typeof input.content !== 'string') throw new Error('content must be a string')
		let observation = await fileChanges.begin(ctx, fileChanges.validateFile(input.path), true)
		try {
			let full = resolve(ctx.cwd, input.path)
			if (ctx.signal.aborted) throw new Error('stopped before writing; nothing was written')
			await mkdir(dirname(full), { recursive: true })
			let bytes = Buffer.from(input.content)
			await lease.commit(full, bytes)
			let lines = lease.text(bytes, input.path).lines.length
			return `== WRITE ${input.path}@${lease.hash(bytes)} ok: ${lines} line${lines === 1 ? '' : 's'}, ${bytes.length} bytes ==`
		} finally {
			await fileChanges.finish(observation)
		}
	},
}
