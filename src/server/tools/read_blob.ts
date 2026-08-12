// Read blob tool — retrieve stored blob data by ID.
//
// Blobs are immutable snapshots of tool outputs, images, and thinking blocks.
// They survive even if the original files change on disk. The agent uses this
// to inspect old tool results or images referenced in conversation history.

import { blob } from '../session/blob.ts'
import { blobRef } from './blob-ref.ts'
import { toolRegistry, type Tool, type ToolContext } from './tool.ts'

const MAX_OUTPUT = 1_000_000

interface ReadBlobInput {
	id?: string
}

function normalizeInput(input: unknown): ReadBlobInput {
	const raw = toolRegistry.inputObject(input)
	return {
		id: raw.id === undefined ? undefined : String(raw.id),
	}
}

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	const spec = normalizeInput(input)
	const id = spec.id
	if (!id) return 'error: id parameter is required'

	const ref = blobRef.parse(id, ctx.sessionId)
	if (!ref) {
		return 'error: invalid blob id (use "blobId" or "sessionId/blobId")'
	}

	const data = blob.readBlobFromChain(ref.sessionId, ref.blobId)
	if (data === null) return `error: blob "${id}" not found`

	// Blob data can be any serializable type — stringify for display.
	const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
	if (text.length > MAX_OUTPUT) {
		return text.slice(0, MAX_OUTPUT) + `\n[… truncated — ${text.length - MAX_OUTPUT} more chars]`
	}
	return text
}

const readBlobToolDef: Tool = {
	name: 'read_blob',
	description:
		'Read a stored blob by ID. Use "blobId" for the current session (or its fork chain), or "sessionId/blobId" for a specific session. Blobs are immutable snapshots of tool outputs, images, and thinking blocks from conversation history.',
	parameters: {
		id: { type: 'string', description: 'Blob ID: either "0gdec4-bol" or "04-fyx/0gdec4-bol"' },
	},
	required: ['id'],
	execute,
}

function init(): void {
	toolRegistry.registerTool(readBlobToolDef)
}

export const readBlobTool = { execute, init }
