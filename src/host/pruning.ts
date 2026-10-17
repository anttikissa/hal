// Provider-only projection. Omission decisions are saved before a request:
// reopening cannot resurrect payloads or slide the cache frontier each round.
import { blocks as conversationBlocks, type Message, type UserBlock } from '../common/blocks.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { diag } from './diag.ts'
import { tokenEstimates } from '../common/token-estimates.ts'
import { tokenCalibration } from './token-calibration.ts'
import { blobs } from './blobs.ts'

type Saved = { boundary: number; checkpoint: number; pressure: number; omitted: number[]; consumed: number[] }
type Budget = { overhead?: number; window?: number; model?: string }

function saved(id: string): Saved {
	return liveFiles.liveFile(`${paths.sessionDir(id)}/projection.ason`, { boundary: 0, checkpoint: 0, pressure: -1, omitted: [], consumed: [] } as Saved, { watch: false })
}

function marker(kind: string, ref: string): string {
	return `[pruned ${kind}; read_entry id=${ref}]`
}

// Match our reserved generated form (read_blob before READ_ENTRY), recursively, before any tool executes.
function copied(value: unknown): string | undefined {
	if (typeof value === 'string') return /\[pruned [^\]\n;]+; read_(?:blob|entry) id=[\w/#.-]+\]/.exec(value)?.[0]
	if (value && typeof value === 'object') for (let child of Object.entries(value).flat()) {
		let found = pruning.copied(child)
		if (found) return found
	}
}

// A long argument keeps its first line (a call's purpose comment), so old
// calls still show real calls to imitate rather than bare markers.
function argumentsOf(value: unknown, ref: string): unknown {
	if (typeof value === 'string' && value.length > pruning.maxArgumentChars) {
		let head = value.split('\n', 1)[0]!.slice(0, pruning.keptArgumentChars)
		return `${head}\n[pruned argument: ${value.length - head.length} more characters; read_entry id=${ref}]`
	}
	if (typeof value === 'string') return value
	if (Array.isArray(value)) return value.map((v) => pruning.argumentsOf(v, ref))
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pruning.argumentsOf(v, ref)]))
	return value
}

function omit(id: string, r: HistoryRecord): HistoryRecord {
	let ref = `${id}/${r.n}`
	if (r.type === 'assistant' && r.block.type === 'tool_call') return { ...r, block: { ...r.block, input: pruning.argumentsOf(r.block.input, ref) as Record<string, unknown>, ...(r.block.cmd !== undefined && { cmd: pruning.argumentsOf(r.block.cmd, ref) as string }) } }
	if (r.type !== 'user') return r
	let slot = 0
	// A bare entry ID reads every part, so name the part when there are several.
	let many = r.blocks.length > 1 || r.blocks.some((b) => b.type === 'tool_result' && conversationBlocks.resultImages(b).length)
	let itemRef = (at: number) => `${id}/${r.n}${many ? `.${at}` : ''}`
	let blocks: UserBlock[] = r.blocks.map((b) => {
		let at = slot++
		if (b.type === 'image') return { type: 'text', text: pruning.marker('image', itemRef(at)) }
		if (b.type !== 'tool_result') return b
		let images = conversationBlocks.resultImages(b)
		slot += images.length
		let output = pruning.marker('tool output', itemRef(at))
		for (let [i] of images.entries()) output += '\n' + pruning.marker('image', itemRef(at + i + 1))
		let { image: _image, images: _images, ...rest } = b
		return { ...rest, output }
	})
	return { ...r, blocks }
}

function heavy(r: HistoryRecord): boolean {
	return (r.type === 'user' && r.blocks.some((b) => b.type === 'image' || b.type === 'tool_result')) ||
		(r.type === 'assistant' && r.block.type === 'tool_call')
}

// Image tokens, measured from real usage. Opus 5.5 (count_tokens): downscale
// to a 2576 px long edge and at most 4,761 patches of 28 px, then one token
// per patch plus 3; older Claude models cost less. OpenAI gpt-6.1 (detail
// auto): no downscaling, floor(1.2 per 32 px patch) + 1, rejecting images
// over 30,000 patches. Unreadable headers count maxImageTokens.
function imageTokens(width: number, height: number, model?: string): number {
	if (model?.startsWith('openai/')) return Math.floor(Math.ceil(width / 32) * Math.ceil(height / 32) * 1.2) + 1
	let scale = Math.min(1, 2576 / Math.max(width, height))
	let patches = Math.ceil(width * scale / 28) * Math.ceil(height * scale / 28)
	if (patches > 4761) {
		scale *= Math.sqrt(4761 / patches)
		patches = Math.ceil(width * scale / 28) * Math.ceil(height * scale / 28)
	}
	return patches + 3
}

// Blobs are immutable, so a header is parsed once per host process. The parser
// loads only when an image is estimated, keeping it off host startup.
const imageSizes = new Map<string, { width: number; height: number } | null>()
function imageCost(id: string, blob: string, model?: string): number {
	let key = `${id}/${blob}`
	let size = imageSizes.get(key)
	if (size === undefined) {
		let found = blobs.read(id, blob)
		let { imageDimensions } = require('../common/image-dimensions.ts') as typeof import('../common/image-dimensions.ts')
		size = (found && imageDimensions.read(found.bytes, found.mediaType)) || null
		imageSizes.set(key, size)
	}
	return size ? pruning.imageTokens(size.width, size.height, model) : pruning.maxImageTokens
}

// Conservative estimate including images and system/tools. Providers bill
// images by pixels, not file bytes.
function estimate(id: string, messages: Message[], overhead = 0, model?: string): number {
	let images = 0
	for (let m of messages) for (let b of m.blocks) {
		let imagesInBlock = b.type === 'image' ? [b] : b.type === 'tool_result' ? conversationBlocks.resultImages(b) : []
		for (let image of imagesInBlock) images += pruning.imageCost(id, image.blob, model)
	}
	return tokenCalibration.estimateTokens(tokenEstimates.characters(messages, overhead), model) + images
}

function project(id: string, all: HistoryRecord[], budget: Budget = {}, materialize: (r: HistoryRecord) => HistoryRecord = (r) => r, projectCurrent: (records: HistoryRecord[]) => HistoryRecord[] = (records) => records): HistoryRecord[] {
	let original = new Map(all.map((r) => [r.n, r]))
	let records = replay.current(all)
	let edited = new Set(records.filter((r) => JSON.stringify(r) !== JSON.stringify(original.get(r.n))).map((r) => r.n))
	all = records = projectCurrent(records).map(materialize)
	let at = records.findLastIndex((r) => r.type === 'compact' || r.type === 'reset')
	let active = records.slice(at + 1)
	let boundary = records[at]?.n ?? 0
	let state = pruning.saved(id)
	try {
		if (state.boundary !== boundary) {
			state.boundary = boundary
			state.checkpoint = 0
			state.pressure = -1
		}
		let consumed = new Set(state.consumed.filter((n) => !edited.has(n)))
		let omitted = new Set(state.omitted.filter((n) => !edited.has(n)))
		let completed = 0
		let ages = new Map<number, number>()
		for (let r of active) {
			if (r.n !== undefined) ages.set(r.n, completed)
			if (r.type === 'turn_end' && r.status === 'completed') completed++
		}
		let checkpoint = Math.floor(completed / pruning.batchTurns) * pruning.batchTurns
		let apply = (set: Set<number>) => all.map((r) => r.n !== undefined && set.has(r.n) ? pruning.omit(id, r) : r)
		let candidates = (old: boolean) => active.filter((r) => r.n !== undefined && !omitted.has(r.n) && consumed.has(r.n) && pruning.heavy(r) && (!old || checkpoint - (ages.get(r.n) ?? checkpoint) > pruning.retainTurns))
		let add = (eligible: HistoryRecord[]) => {
			let next = new Set(omitted)
			for (let r of eligible) if (JSON.stringify(pruning.omit(id, r)).length < JSON.stringify(r).length) next.add(r.n!)
			if (next.size === omitted.size) return false
			omitted = next
			return true
		}
		if (checkpoint > state.checkpoint) {
			add(candidates(true))
			state.checkpoint = checkpoint
			state.pressure = -1
		}
		let projected = apply(omitted)
		let limit = Math.min(pruning.pressureTokens, (budget.window ?? Infinity) * .75)
		if (state.pressure !== checkpoint && pruning.estimate(id, replay.toMessages(projected), budget.overhead, budget.model) > limit && add(candidates(false))) {
			state.pressure = checkpoint
			diag.log(`pruning ${id}: pressure boundary at checkpoint ${checkpoint}; omitted ${omitted.size} records`)
			projected = apply(omitted)
		}
		state.omitted = [...omitted]
		liveFiles.save(state)
		return projected
	} finally { liveFiles.close(state) }
}

// Only a successful provider round proves it read these payloads. Capture
// its input records before streaming: newly returned results are not included.
function consumed(id: string, records: HistoryRecord[]): void {
	let state = pruning.saved(id)
	try {
		state.consumed = [...new Set([...state.consumed, ...records.filter(pruning.heavy).flatMap((r) => r.n === undefined ? [] : [r.n])])]
		liveFiles.save(state)
	} finally { liveFiles.close(state) }
}

export const pruning = {
	saved, marker, copied, argumentsOf, omit, heavy, imageTokens, imageCost, estimate, project, consumed,
	batchTurns: 8,
	retainTurns: 4,
	maxArgumentChars: 1000,
	keptArgumentChars: 200,
	pressureTokens: 180_000,
	maxImageTokens: 4_800,
}
