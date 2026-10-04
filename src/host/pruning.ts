// Provider-only projection. Omission decisions are saved before a request:
// reopening cannot resurrect payloads or slide the cache frontier each round.
import type { Message, UserBlock } from '../common/blocks.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { diag } from './diag.ts'
import { tokenEstimates } from '../common/token-estimates.ts'
import { tokenCalibration } from './token-calibration.ts'

type Saved = { boundary: number; checkpoint: number; pressure: number; omitted: number[]; consumed: number[] }
type Budget = { overhead?: number; window?: number; model?: string }

function saved(id: string): Saved {
	return liveFiles.liveFile(`${paths.sessionDir(id)}/projection.ason`, { boundary: 0, checkpoint: 0, pressure: -1, omitted: [], consumed: [] } as Saved, { watch: false })
}

function marker(kind: string, ref: string): string {
	return `[pruned ${kind}; read_blob id=${ref}]`
}

// Match our reserved generated form, recursively, before any tool executes.
function copied(value: unknown): string | undefined {
	if (typeof value === 'string') return /\[pruned [^\]\n;]+; read_blob id=[\w/#-]+\]/.exec(value)?.[0]
	if (value && typeof value === 'object') for (let child of Object.entries(value).flat()) {
		let found = pruning.copied(child)
		if (found) return found
	}
}

function argumentsOf(value: unknown, ref: string): unknown {
	if (typeof value === 'string') return value.length > pruning.maxArgumentChars ? pruning.marker('argument', ref) : value
	if (Array.isArray(value)) return value.map((v) => pruning.argumentsOf(v, ref))
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pruning.argumentsOf(v, ref)]))
	return value
}

function omit(id: string, r: HistoryRecord): HistoryRecord {
	let ref = `${id}#${r.n}`
	if (r.type === 'assistant' && r.block.type === 'tool_call') return { ...r, block: { ...r.block, input: pruning.argumentsOf(r.block.input, ref) as Record<string, unknown> } }
	if (r.type !== 'user') return r
	let blocks: UserBlock[] = r.blocks.map((b) => {
		if (b.type === 'image') return { type: 'text', text: pruning.marker('image', `${id}/${b.blob}`) }
		if (b.type !== 'tool_result') return b
		let full = /whole output in blob ([0-9a-f]{12}|[0-9a-z]{6})\b/.exec(b.output)?.[1]
		let output = pruning.marker('tool output', full ? `${id}/${full}` : ref)
		if (b.image) output += '\n' + pruning.marker('image', `${id}/${b.image.blob}`)
		let { image: _image, ...rest } = b
		return { ...rest, output }
	})
	return { ...r, blocks }
}

function heavy(r: HistoryRecord): boolean {
	return (r.type === 'user' && r.blocks.some((b) => b.type === 'image' || b.type === 'tool_result')) ||
		(r.type === 'assistant' && r.block.type === 'tool_call')
}

// Conservative character estimate, including image payloads and system/tools.
function estimate(messages: Message[], overhead = 0, model?: string): number {
	let images = messages.reduce((sum, m) => sum + m.blocks.reduce((n, b) => n + (b.type === 'image' ? b.bytes ?? 0 : b.type === 'tool_result' ? b.image?.bytes ?? 0 : 0), 0), 0)
	return tokenCalibration.estimateTokens(tokenEstimates.characters(messages, overhead), model) + tokenEstimates.estimate(images)
}

function project(id: string, all: HistoryRecord[], budget: Budget = {}, materialize: (r: HistoryRecord) => HistoryRecord = (r) => r): HistoryRecord[] {
	let original = new Map(all.map((r) => [r.n, r]))
	let records = replay.current(all)
	let edited = new Set(records.filter((r) => JSON.stringify(r) !== JSON.stringify(original.get(r.n))).map((r) => r.n))
	all = records = records.map(materialize)
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
		if (state.pressure !== checkpoint && pruning.estimate(replay.toMessages(projected), budget.overhead, budget.model) > limit && add(candidates(false))) {
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
	saved, marker, copied, argumentsOf, omit, heavy, estimate, project, consumed,
	batchTurns: 8,
	retainTurns: 4,
	maxArgumentChars: 1000,
	pressureTokens: 180_000,
}
