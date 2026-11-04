// Edits of a prompt, rewinds to one and their undos (tasks hx8, 26q)
// stay in the history file (task e4z): a quiet rebase record leaves
// lines out, which the marks keep as inactive byte ranges, so readers
// skip them without reading them.
import { replay, type HistoryRecord } from '../common/replay.ts'
import { history } from './history.ts'
import { pages, type Marks, type Range } from './pages.ts'
import { turnMarks } from './turn-marks.ts'

// A quiet rebase that only drops: an amendment.
function is(r: HistoryRecord): boolean {
	return r.type === 'rebase' && r.quiet === true && !r.edit.length
}

// Marks after an amendment, from the first `end` bytes of the history:
// the turn state of the records it leaves active and the ranges of the
// lines it leaves out. The changed files stay: an amended turn's changes
// remain on disk.
function apply(id: string, m: Marks, path: string, end: number): void {
	let lines = pages.bounds(pages.readBytes(path, 0, end), 0)
	let records = history.readSync(id).slice(0, lines.length)
	let active = new Set(replay.current(records).map((r) => r.n))
	for (let key of ['transitions', 'question', 'turnQuestion', 'answer', 'turn', 'ended', 'prompt', 'reply'] as const)
		delete m[key]
	let inactive: Range[] = [],
		dropped: number[] = []
	m.inbox = {}
	records.forEach((r, i) => {
		let [start, stop] = lines[i]!
		if (r.type !== 'rebase' && active.has(r.n)) return turnMarks.follow(m, r, start)
		let last = inactive.at(-1)
		if (last?.[1] === start) last[1] = stop
		else inactive.push([start, stop])
		if (r.type !== 'rebase') dropped.push(r.n!)
	})
	Object.assign(m, { inactive, dropped })
}

// Whether the line at `offset` is one an amendment left out.
function inactiveAt(m: Marks, offset: number): boolean {
	return m.inactive?.some(([s, e]) => offset >= s && offset < e) ?? false
}

// [from, end) without the inactive ranges.
function spans(inactive: Range[], from: number, end: number): Range[] {
	let out: Range[] = []
	for (let [s, e] of [...inactive, [end, end] as Range]) {
		if (from >= end) break
		if (e <= from) continue
		if (s > from) out.push([from, Math.min(s, end)])
		from = Math.max(from, e)
	}
	return out
}

// Where the last `n` active bytes before `end` start; 0 when `n` covers
// all `total` of them.
function back(inactive: Range[], end: number, n: number, total: number): number {
	if (n >= total) return 0
	let at = end
	for (let i = inactive.length - 1; i >= 0; i--) {
		let [s, e] = inactive[i]!
		if (s >= at) continue
		let gap = at - Math.min(e, at)
		if (gap >= n) break
		n -= gap
		at = s
	}
	return Math.max(0, at - n)
}

export const amendments = { is, apply, inactiveAt, spans, back }
