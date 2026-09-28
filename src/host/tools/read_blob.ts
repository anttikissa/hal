// Recover a whole stored tool result, attachment image, or history block.
import { attachments } from '../../common/attachments.ts'
import { blobs } from '../blobs.ts'
import { history } from '../history.ts'
import { type Tool, type ToolOutput, tools } from '../tools.ts'

export const tool: Tool<ToolOutput> = {
	name: 'read_blob',
	description: 'Read a stored blob or history block. Text comes in pages: use offset (first line, 1-based) and limit (number of lines) to continue. Images return as images.',
	parameters: {
		type: 'object',
		properties: { id: { type: 'string', description: 'A blob id, sessionId/blobId, #35, or sessionId#35' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } },
		required: ['id'],
	},
	readOnly: true,
	async run(input, ctx) {
		if (typeof input.id !== 'string') throw new Error('id must be a string')
		for (let key of ['offset', 'limit'] as const) if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || input[key] < 1)) throw new Error(`${key} must be a positive integer`)
		let page = (text: string) => tools.page(text, input.offset as number | undefined, input.limit as number | undefined)
		let ref = /^(?:([\w-]+)\/)?([0-9a-f]{12}|[0-9a-z]{6})$/.exec(input.id)
		let block = /^(?:([\w-]+))?#([1-9]\d*)$/.exec(input.id)
		if (!ref && !block) throw new Error(`invalid blob or block id: ${JSON.stringify(input.id)}`)
		if (block) {
			let n = Number(block[2])
			if (!Number.isSafeInteger(n)) throw new Error('block number is too large')
			let id = block[1] ?? ctx.sessionId
			let record = history.readSync(id).find((r) => r.n === n)
			if (!record) throw new Error(`block ${input.id} not found`)
			let value = record.type === 'assistant' ? record.block : record.type === 'user' && record.blocks.length === 1 ? record.blocks[0] : record
			if (value?.type === 'image') {
				let image = blobs.read(id, value.blob)
				if (!image) throw new Error(`image blob ${value.blob} not found`)
				return { text: `Image block ${input.id}`, image: { mediaType: image.mediaType, data: image.bytes.toString('base64') } }
			}
			let text = JSON.stringify(value, null, 2)
			return page(text)
		}
		let id = ref![1] ?? ctx.sessionId
		let blob = ref![2]!
		if (!attachments.blobId.test(blob)) throw new Error('invalid blob id')
		let data = blobs.read(id, blob)
		if (!data) throw new Error(`blob ${input.id} not found`)
		if (data.mediaType !== 'text/plain') return { text: `Image blob ${input.id}`, image: { mediaType: data.mediaType, data: data.bytes.toString('base64') } }
		let text = data.bytes.toString('utf8')
		return page(text)
	},
}
