// Recover a whole stored tool result, attachment image, or history block.
import { replay } from '../../common/replay.ts'
import { attachments } from '../../common/attachments.ts'
import { blocks, type UserBlock } from '../../common/blocks.ts'
import { toolDetails } from '../../common/tool-details.ts'
import { blobs } from '../blobs.ts'
import { history } from '../history.ts'
import { type Tool, type ToolOutput, tools } from '../tools.ts'

export const tool: Tool<ToolOutput> = {
	name: 'read_blob',
	syntax: { summary: 'read stored output or history' },
	description: 'Read an immutable blob or history record. Text is paged; images return as images.',
	parameters: {
		type: 'object',
		properties: {
			id: { type: 'string', description: 'A history item: <session id>/35, or t35 in this session (the number on a card, after any kind letter). Add .1 for its first part. Or a blob id from a cut output: <blob id> or <session id>/<blob id>.' },
			offset: { type: 'integer', minimum: 1, description: 'First line, 1-based' },
			limit: { type: 'integer', minimum: 1, description: 'Number of lines' },
			charOffset: { type: 'integer', minimum: 1, description: '1-based character position; use instead of offset for lossless recovery of long or cut lines and JSON' },
		},
		required: ['id'],
	},
	readOnly: true,
	async run(input, ctx) {
		if (typeof input.id !== 'string') throw new Error('id must be a string')
		let reference = input.id.trim()
		for (let key of ['offset', 'limit', 'charOffset'] as const) if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || input[key] < 1)) throw new Error(`${key} must be a positive integer`)
		let page = (text: string) => {
			if (input.charOffset === undefined) return tools.page(text, input.offset as number | undefined, input.limit as number | undefined)
			let at = (input.charOffset as number) - 1
			if (at > text.length) throw new Error(`charOffset ${input.charOffset} is past the end (${text.length} characters)`)
			let end = Math.min(text.length, at + Math.max(1, tools.maxChars - 200))
			return text.slice(at, end) + (end < text.length ? `\n[characters ${at + 1}-${end} of ${text.length}; continue with charOffset ${end + 1}]` : '')
		}
		let ref = /^(?:([\w-]+)\/)?([0-9a-f]{12}|[0-9a-z]{6})$/.exec(reference)
		let block = /^(?:([\w-]+)\/|[a-z])([1-9]\d*)(?:\.([1-9]\d*))?$/.exec(reference)
		if (ref && block && blobs.find(ref[1] ?? ctx.sessionId, ref[2]!)) block = null
		if (!ref && !block) throw new Error(`invalid blob or card id: ${JSON.stringify(input.id)}`)
		if (block) {
			let n = Number(block[2])
			if (!Number.isSafeInteger(n)) throw new Error('card number is too large')
			let slot = block[3] === undefined ? undefined : Number(block[3])
			if (slot !== undefined && !Number.isSafeInteger(slot)) throw new Error('item number is too large')
			let id = block[1] ?? ctx.sessionId
			let raw = history.readSync(id)
			let record = replay.current(raw).find((r) => r.n === n)
			if (!record && raw.some((r) => r.n === n)) return `Card ${input.id} was dropped by rebase.`
			if (!record) throw new Error(`card ${input.id} not found`)
			let value = record.type === 'assistant' ? record.block : record.type === 'user' && record.blocks.length === 1 ? record.blocks[0] : record
			if (slot !== undefined || reference.includes('/')) {
				let items = record.type === 'user' ? record.blocks.flatMap((b): UserBlock[] => b.type === 'tool_result' ? [b, ...blocks.resultImages(b)] : [b]) : [value]
				value = items[slot ?? 0]
				if (!value) throw new Error(`history item ${input.id} not found`)
			}
			let refs = value?.type === 'tool_result' ? blocks.resultImages(value) : value?.type === 'image' ? [value] : value?.type === 'user' ? value.blocks.flatMap((b) => b.type === 'image' ? [b] : b.type === 'tool_result' ? blocks.resultImages(b) : []) : []
			let text = value?.type === 'tool_result' ? value.output : value?.type === 'image' ? `Image block ${input.id}` : value?.type === 'tool_call'
				? [toolDetails.headline(value.name, value.input).text, ...toolDetails.lines(value.name, value.input)].join('\n')
				: toolDetails.value(value).join('\n')
			let images: { mediaType: string; data: string; source: string }[] = []
			let errors: string[] = []
			if (value?.type === 'tool_result') {
				let blob = value.outputBlob ?? /\n\[cut: [^\n]*whole output in blob ([0-9a-f]{12}|[0-9a-z]{6})\.[^\n]*\]$/.exec(value.output)?.[1]
				if (blob) {
					try { text = blobs.text(id, blob) }
					catch (e: any) { errors.push(`Error reading output blob ${id}/${blob}: ${e?.message ?? e}`) }
				}
			}
			for (let ref of refs) {
				let source = `${id}/${ref.blob}`
				try {
					let image = blobs.read(id, ref.blob)
					if (!image) throw new Error(`image blob ${source} not found`)
					images.push({ mediaType: image.mediaType, data: image.bytes.toString('base64'), source })
				} catch (e: any) {
					errors.push(`Error reading image blob ${source}: ${e?.message ?? e}`)
				}
			}
			let output = [page(text), ...errors].join('\n')
			return images.length || errors.length ? { text: output, images, ...(errors.length && { isError: true }) } : output
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
