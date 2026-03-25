// Read blob tool — retrieve stored blob data by ID.
//
// Blobs are immutable snapshots of tool outputs, images, and thinking blocks.
// They survive even if the original files change on disk. The agent uses this
// to inspect old tool results or images referenced in conversation history.

import { blob } from '../session/blob.ts'
import { toolRegistry, type ToolContext } from './tool.ts'

const MAX_OUTPUT = 1_000_000

async function execute(input: any, ctx: ToolContext): Promise<string> {
	const id = input?.id
	if (!id || typeof id !== 'string') return 'error: id parameter is required'

	const data = blob.readBlobFromChain(ctx.sessionId, id)
	if (data === null) return `error: blob "${id}" not found`

	// Blob data can be any serializable type — stringify for display
	const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
	if (text.length > MAX_OUTPUT) {
		return text.slice(0, MAX_OUTPUT) + `\n[… truncated — ${text.length - MAX_OUTPUT} more chars]`
	}
	return text
}

toolRegistry.registerTool({
	name: 'read_blob',
	description:
		'Read a stored blob by ID. Blobs are immutable snapshots of tool outputs, images, and thinking blocks from conversation history.',
	parameters: {
		id: { type: 'string', description: 'Blob ID (found in history entries like "blob <id>")' },
	},
	required: ['id'],
	execute,
})

export const readBlobTool = { execute }
