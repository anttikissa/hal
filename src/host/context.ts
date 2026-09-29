// The points of the context graph (task c4): one per provider round,
// built from a session's history alone. A round's `round` record gives
// its usage; a turn from before those records is one point from its
// turn end (`approx`). Drop causes are named only where history knows
// them: a compact or reset between two rounds, a pruning checkpoint
// (every pruning.batchTurns() completed turns, task 0d) or a cache miss.
import type { HistoryRecord } from '../common/replay.ts'
import { history } from './history.ts'
import { models } from './models.ts'
import { pruning } from './pruning.ts'
import { liveFiles } from './live-file.ts'
import { sessions } from './sessions.ts'

export type Cause = 'compaction' | 'clear' | 'pruning checkpoint' | 'cache miss'
export type Point = { n: number; ts: string; turn: number; round: number; input: number; cacheRead: number; cacheWrite: number; total: number; block?: number; model?: string; approx?: true; cause?: Cause; window?: number }

function points(records: HistoryRecord[], window: (model?: string) => number | undefined = () => undefined): Point[] {
	let out: Point[] = []
	let turn = 0, round = 0, completed = 0, roundsInTurn = 0
	let boundary: Cause | undefined
	let checkpoint = 0
	for (let r of records) {
		if (r.type === 'compact' || r.type === 'reset') {
			boundary = r.type === 'compact' ? 'compaction' : 'clear'
			completed = 0
			checkpoint = 0
		} else if (r.type === 'user' && r.blocks.some((b) => b.type !== 'tool_result')) {
			turn++
			roundsInTurn = 0
		} else if (r.type === 'turn_end' && r.status === 'completed') completed++
		if (r.type !== 'round' && !(r.type === 'turn_end' && r.context && !roundsInTurn)) continue
		let usage = r.type === 'round' ? r.usage : { input: r.context }
		let p: Point = { n: r.n ?? out.length + 1, ts: r.ts, turn, round: ++round, input: usage.input ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, total: 0 }
		p.total = p.input + p.cacheRead + p.cacheWrite
		if (r.type === 'round') {
			roundsInTurn++
			if (r.block !== undefined) p.block = r.block
			if (r.model !== undefined) p.model = r.model
		} else p.approx = true
		let w = window(p.model)
		if (w) p.window = w
		let prev = out.at(-1)
		let now = Math.floor(completed / pruning.batchTurns())
		if (prev) {
			if (p.total < prev.total * 0.9) {
				if (boundary) p.cause = boundary
				else if (now > checkpoint) p.cause = 'pruning checkpoint'
			} else if (prev.cacheRead > 1000 && p.cacheRead < prev.cacheRead * 0.1) p.cause = 'cache miss'
		}
		boundary = undefined
		checkpoint = now
		out.push(p)
	}
	return out
}

function of(id: string): Point[] {
	// A page for a closed session must not open it (or save its metadata).
	let fallback = sessions.state.open.get(id)?.model
	if (fallback === undefined) {
		let meta = sessions.load(id, false)
		liveFiles.close(meta)
		fallback = meta.model
	}
	return context.points(history.readSync(id), (model) => models.contextWindow(model ?? fallback))
}

export const context = { points, of }
