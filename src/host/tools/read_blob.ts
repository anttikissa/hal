// Recover a whole stored tool result, attachment image, or history block.
import { replay } from '../../common/replay.ts'
import { attachments } from '../../common/attachments.ts'
import { blobs } from '../blobs.ts'
import { history } from '../history.ts'
import { type Tool, type ToolOutput, tools } from '../tools.ts'

export const tool: Tool<ToolOutput> = {
	name: 'read_blob',
	description: 'Read an immutable blob or history record. Text is paged with offset (first line, 1-based) and limit. For lossless recovery of long/cut lines or JSON use charOffset (1-based character position) instead. Images return as images.',
	parameters: {
		type: 'object',
		properties: { id: { type: 'string', description: 'A blob id, sessionId/blobId, a block id (#t35; any kind letter or none), or sessionId#t35' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 }, charOffset: { type: 'integer', minimum: 1 } },
		required: ['id'],
	},
	readOnly: true,
	async run(input, ctx) {
		if (typeof input.id !== 'string') throw new Error('id must be a string')
		for (let key of ['offset', 'limit', 'charOffset'] as const) if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || input[key] < 1)) throw new Error(`${key} must be a positive integer`)
		let page = (text: string) => {
			if (input.charOffset === undefined) return tools.page(text, input.offset as number | undefined, input.limit as number | undefined)
			let at = (input.charOffset as number) - 1
			if (at > text.length) throw new Error(`charOffset ${input.charOffset} is past the end (${text.length} characters)`)
			let end = Math.min(text.length, at + Math.max(1, tools.maxChars - 200))
			return text.slice(at, end) + (end < text.length ? `\n[characters ${at + 1}-${end} of ${text.length}; continue with charOffset ${end + 1}]` : '')
		}
		let ref = /^(?:([\w-]+)\/)?([0-9a-f]{12}|[0-9a-z]{6})$/.exec(input.id)
		let block = /^(?:([\w-]+))?#[a-z]?([1-9]\d*)$/.exec(input.id)
		if (!ref && !block) throw new Error(`invalid blob or block id: ${JSON.stringify(input.id)}`)
		if (block) {
			let n = Number(block[2])
			if (!Number.isSafeInteger(n)) throw new Error('block number is too large')
			let id = block[1] ?? ctx.sessionId
			let raw = history.readSync(id)
			let record = replay.current(raw).find((r) => r.n === n)
			if (!record && raw.some((r) => r.n === n)) return `Block ${input.id} was dropped by rebase.`
			if (!record) throw new Error(`block ${input.id} not found`)
			let value = record.type === 'assistant' ? record.block : record.type === 'user' && record.blocks.length === 1 ? record.blocks[0] : record
			if (value?.type === 'tool_result') {
				if (!value.image) return page(value.output)
				let image = blobs.read(id, value.image.blob)
				if (!image) throw new Error(`image blob ${value.image.blob} not found`)
				return { text: page(value.output), image: { mediaType: image.mediaType, data: image.bytes.toString('base64') } }
			}
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
