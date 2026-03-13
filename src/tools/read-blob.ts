import { blob } from '../session/blob.ts'
import { ason } from '../utils/ason.ts'
import { defineTool, previewField, type ToolContext } from './tool.ts'

function formatPreview(blobId: string, blobData: unknown, truncate: (text: string) => string): string {
	if (blobData && typeof blobData === 'object') {
		const mediaType = (blobData as { media_type?: unknown }).media_type
		const data = (blobData as { data?: unknown }).data
		if (typeof mediaType === 'string' && mediaType.startsWith('image/')) {
			const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'base64') : 0
			return `[blob ${blobId}] { kind: image, media_type: ${mediaType}, bytes: ${bytes} }`
		}
	}
	const text = ason.stringify(blobData)
	return truncate(`[blob ${blobId}] ${text}`)
}

const definition = {
	name: 'read_blob',
	description: 'Read a stored session blob by id. Use this when history mentions `blob <id>` or an omitted image/tool result points at a blob.',
	input_schema: {
		type: 'object',
		properties: {
			blobId: {
				type: 'string',
				description: 'Stable blob id (for example from an omitted image, tool result, or thinking blob)',
			},
		},
		required: ['blobId'],
	},
}

const blobIdPreview = previewField('blobId')

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	if (!ctx.sessionId) throw new Error('read_blob requires sessionId context')
	if (!ctx.truncate) throw new Error('read_blob requires truncate in context')
	const blobId = blobIdPreview(input).trim()
	const blobData = await blob.read(ctx.sessionId, blobId)
	return formatPreview(blobId, blobData, ctx.truncate)
}

export const readBlob = Object.assign(
	defineTool({
		definition,
		argsPreview: blobIdPreview,
		execute,
	}),
	{ formatPreview },
)
