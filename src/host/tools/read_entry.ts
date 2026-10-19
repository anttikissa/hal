// READ_ENTRY: a history entry with the blobs it refers to (whole tool
// output, images), one part of it, a range of entries, or a blob by id.
import { replay, type HistoryRecord } from '../../common/replay.ts'
import { attachments } from '../../common/attachments.ts'
import {
	blocks,
	type ImageBlock,
	type ToolCallBlock,
	type ToolResultBlock,
	type UserBlock,
} from '../../common/blocks.ts'
import { toolDetails } from '../../common/tool-details.ts'
import { blobs } from '../blobs.ts'
import { history } from '../history.ts'
import { type Tool, type ToolOutput, tools } from '../tools.ts'
import { callText } from '../../common/call-text.ts'
import { nativeTool } from '../native-tool.ts'

type Image = { mediaType: string; data: string; source: string }
type Found = { images: Image[]; errors: string[] }

const BLOB = /^(?:([\w-]+)\/)?([0-9a-f]{12}|[0-9a-z]{6})$/
const ENTRY = /^(?:([\w-]+)\/)?[a-z]?([1-9]\d*)(?:\.(\d+))?$/
const RANGE = /^(?:([\w-]+)\/)?[a-z]?([1-9]\d*)\s*-\s*[a-z]?([1-9]\d*)$/
const CUT = /\n\[cut: [^\n]*whole output in blob ([0-9a-f]{12}|[0-9a-z]{6})\.[^\n]*\]$/

// READ_ENTRY "id" "id" ... reads each whole first page, like READ's paths.
function resolveCall(raw: string): { name: string; input: Record<string, unknown> } {
	let { values } = callText.values(raw)
	if (values.length > 1 && values.every((v) => typeof v === 'string' && v))
		return { name: 'read_entry', input: { ids: values } }
	return { name: 'read_entry', input: nativeTool.generic(tool, raw) }
}

function number(text: string, what: string): number {
	let n = Number(text)
	if (!Number.isSafeInteger(n)) throw new Error(`${what} is too large`)
	return n
}

function addImages(session: string, refs: ImageBlock[], found: Found): void {
	for (let ref of refs) {
		let source = `${session}/${ref.blob}`
		try {
			let image = blobs.read(session, ref.blob)
			if (!image) throw new Error(`image blob ${source} not found`)
			found.images.push({ mediaType: image.mediaType, data: image.bytes.toString('base64'), source })
		} catch (e: any) {
			found.errors.push(`Error reading image blob ${source}: ${e?.message ?? e}`)
		}
	}
}

// A tool result's whole output, read back from its blob when it was cut.
function wholeOutput(session: string, b: ToolResultBlock, found: Found): string {
	let blob = b.outputBlob ?? CUT.exec(b.output)?.[1]
	if (!blob) return b.output
	try {
		return blobs.text(session, blob)
	} catch (e: any) {
		found.errors.push(`Error reading output blob ${session}/${blob}: ${e?.message ?? e}`)
		return b.output
	}
}

function callLines(call: ToolCallBlock): string {
	return [toolDetails.headline(call.name, call.input).text, ...toolDetails.lines(call.name, call.input)].join('\n')
}

function partText(session: string, value: unknown, id: string, found: Found): string {
	let b = value as UserBlock | ToolCallBlock
	if (b.type === 'tool_result') {
		addImages(session, blocks.resultImages(b), found)
		return wholeOutput(session, b, found)
	}
	if (b.type === 'image') {
		addImages(session, [b], found)
		return `Image ${id}`
	}
	if (b.type === 'tool_call') return callLines(b)
	return toolDetails.value(value).join('\n')
}

function resultOf(records: HistoryRecord[], callId: string): ToolResultBlock | undefined {
	for (let r of records)
		if (r.type === 'user') for (let b of r.blocks) if (b.type === 'tool_result' && b.id === callId) return b
}

// An entry's parts as their cards number them: a tool call, then its
// result; a user entry's blocks, each result followed by its images.
function parts(record: HistoryRecord, records: HistoryRecord[]): unknown[] {
	if (record.type === 'assistant' && record.block.type === 'tool_call') {
		let result = resultOf(records, record.block.id)
		return result ? [record.block, result] : [record.block]
	}
	if (record.type === 'assistant') return [record.block]
	if (record.type === 'user')
		return record.blocks.flatMap((b): UserBlock[] => (b.type === 'tool_result' ? [b, ...blocks.resultImages(b)] : [b]))
	return [record]
}

// A whole entry: a tool call with its whole result; a user entry with
// every cut output read back and every image.
function entryText(session: string, record: HistoryRecord, records: HistoryRecord[], id: string, found: Found): string {
	if (record.type === 'assistant' && record.block.type === 'tool_call') {
		let result = resultOf(records, record.block.id)
		return `${callLines(record.block)}\n\n${result ? `Result:\n${partText(session, result, id, found)}` : 'No result recorded.'}`
	}
	if (record.type === 'assistant') return partText(session, record.block, id, found)
	if (record.type === 'user' && record.blocks.length === 1) return partText(session, record.blocks[0], id, found)
	if (record.type === 'user') {
		let whole = record.blocks.map((b) => {
			if (b.type === 'image') addImages(session, [b], found)
			if (b.type !== 'tool_result') return b
			addImages(session, blocks.resultImages(b), found)
			return { ...b, output: wholeOutput(session, b, found) }
		})
		return toolDetails.value({ ...record, blocks: whole }).join('\n')
	}
	return toolDetails.value(record).join('\n')
}

export const tool: Tool<ToolOutput> = {
	name: 'read_entry',
	syntax: {
		summary: 'read a history entry, its whole output and images',
		usage: [
			'READ_ENTRY "<id>" [ { offset, limit, charOffset } ]',
			'READ_ENTRY "<id>" "<id>" ...   // several, first page of each',
		],
		resolve: resolveCall,
	},
	description:
		'Read a history entry with the whole output and images it refers to, one part of it, or a range of entries. Text is paged; images return as images.',
	parameters: {
		type: 'object',
		properties: {
			id: {
				type: 'string',
				description:
					"An entry ID from a card or a [12:34 t35] header: t35 in this session, 176-ray/t35 in another. A tool call gives the call and its whole result. Add .N for part N alone (t35.1 is a call's result). A range t30-t40 lists entries. A blob id from a cut notice also works.",
			},
			offset: { type: 'integer', minimum: 1, description: 'First line, 1-based' },
			limit: { type: 'integer', minimum: 1, description: 'Number of lines' },
			charOffset: {
				type: 'integer',
				minimum: 1,
				description:
					'1-based character position; use instead of offset for lossless recovery of long or cut lines and JSON',
			},
		},
		required: ['id'],
	},
	readOnly: true,
	async run(input, ctx) {
		if (Array.isArray(input.ids)) {
			let texts: string[] = [],
				errors: string[] = []
			let images: Image[] = []
			for (let id of input.ids) {
				try {
					let out = await tool.run({ id }, ctx)
					if (typeof out !== 'string')
						images.push(
							...[...(out.image ? [out.image] : []), ...(out.images ?? [])].map((image) => ({
								source: String(id),
								...image,
							})),
						)
					let text = `== READ_ENTRY ${id} ==\n${typeof out === 'string' ? out : out.text}`
					;(typeof out !== 'string' && out.isError ? errors : texts).push(text)
				} catch (e: any) {
					errors.push(`== READ_ENTRY ${id}: ${e?.message ?? e} ==`)
				}
			}
			let text = [...errors, ...texts].join('\n\n')
			return images.length || errors.length ? { text, images, ...(errors.length && { isError: true }) } : text
		}
		if (typeof input.id !== 'string') throw new Error('id must be a string')
		let reference = input.id.trim()
		for (let key of ['offset', 'limit', 'charOffset'] as const)
			if (
				input[key] !== undefined &&
				(typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || input[key] < 1)
			)
				throw new Error(`${key} must be a positive integer`)
		let page = (text: string) => {
			if (input.charOffset === undefined)
				return tools.page(text, input.offset as number | undefined, input.limit as number | undefined)
			let at = (input.charOffset as number) - 1
			if (at > text.length)
				throw new Error(`charOffset ${input.charOffset} is past the end (${text.length} characters)`)
			let end = Math.min(text.length, at + Math.max(1, tools.maxChars - 200))
			return (
				text.slice(at, end) +
				(end < text.length
					? `\n[characters ${at + 1}-${end} of ${text.length}; continue with charOffset ${end + 1}]`
					: '')
			)
		}
		let blob = BLOB.exec(reference)
		let entry = ENTRY.exec(reference)
		let range = RANGE.exec(reference)
		if (blob && entry && blobs.find(blob[1] ?? ctx.sessionId, blob[2]!)) entry = null
		if (range) {
			let session = range[1] ?? ctx.sessionId
			let from = number(range[2]!, 'entry number'),
				to = number(range[3]!, 'entry number')
			if (to < from) throw new Error(`range ${input.id} ends before it starts`)
			let rows = replay.current(history.readSync(session)).filter((r) => r.n !== undefined && r.n >= from && r.n <= to)
			if (!rows.length) throw new Error(`no entries in ${input.id}`)
			return page(rows.map((r) => `== ${r.n} ==\n${toolDetails.value(r).join('\n')}`).join('\n\n'))
		}
		if (entry) {
			let session = entry[1] ?? ctx.sessionId
			let n = number(entry[2]!, 'entry number')
			let slot = entry[3] === undefined ? undefined : number(entry[3], 'part number')
			let raw = history.readSync(session)
			let records = replay.current(raw)
			let record = records.find((r) => r.n === n)
			if (!record && raw.some((r) => r.n === n)) return `Entry ${input.id} was dropped by rebase.`
			if (!record) throw new Error(`entry ${input.id} not found`)
			let found: Found = { images: [], errors: [] }
			let text: string
			if (slot === undefined) text = entryText(session, record, records, reference, found)
			else {
				let value = parts(record, records)[slot]
				if (value === undefined) throw new Error(`entry ${input.id} not found: entry ${n} has no part ${slot}`)
				text = partText(session, value, reference, found)
			}
			let output = [page(text), ...found.errors].join('\n')
			return found.images.length || found.errors.length
				? { text: output, images: found.images, ...(found.errors.length && { isError: true }) }
				: output
		}
		if (!blob) throw new Error(`invalid entry id: ${JSON.stringify(input.id)}; use t35, 176-ray/t35, t35.1 or t30-t40`)
		let session = blob[1] ?? ctx.sessionId
		if (!attachments.blobId.test(blob[2]!)) throw new Error('invalid blob id')
		let data = blobs.read(session, blob[2]!)
		if (!data) throw new Error(`blob ${input.id} not found`)
		if (data.mediaType !== 'text/plain')
			return {
				text: `Image blob ${input.id}`,
				image: { mediaType: data.mediaType, data: data.bytes.toString('base64') },
			}
		return page(data.bytes.toString('utf8'))
	},
}
