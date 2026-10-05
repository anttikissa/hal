import { expect, test } from 'bun:test'
import type { HistoryRecord } from '../common/replay.ts'
import { context } from './context.ts'

const ts = '2026-09-30T00:00:00.000Z'
const prompt = (n: number): HistoryRecord => ({ type: 'user', n, blocks: [{ type: 'text', text: 'hi' }], ts })
const round = (n: number, input: number, cacheRead: number, cacheWrite = 0): HistoryRecord => ({ type: 'round', n, usage: { input, cacheRead, cacheWrite }, block: n - 1, ts })
const done = (n: number): HistoryRecord => ({ type: 'turn_end', n, status: 'completed', usage: {}, ts })

test('rounds become points with turns; drops are labeled only where history knows the cause', () => {
	let records: HistoryRecord[] = [prompt(1), round(3, 1000, 0, 9000), round(5, 500, 9500), done(6), prompt(7), round(9, 500, 10000)]
	// A cache miss: the total stays but the cache read is gone.
	records.push(round(10, 500, 0, 10000))
	records.push({ type: 'compact', n: 11, summary: 's', prompts: 1, ts }, prompt(12), round(14, 500, 0, 2000))
	let pts = context.points(records)
	expect(pts.map((p) => [p.round, p.turn, p.total, p.cause])).toEqual([[1, 1, 10000, undefined], [2, 1, 10000, undefined], [3, 2, 10500, undefined], [4, 2, 10500, 'cache miss'], [5, 3, 2500, 'compaction']])
	expect(pts[0]!.block).toBe(2)
})

test('a pruning checkpoint labels the drop after every batch of completed turns; an unexplained drop stays unlabeled', () => {
	let records: HistoryRecord[] = []
	let n = 1
	for (let t = 0; t < 9; t++) records.push(prompt(n++), round(n++, 0, t < 8 ? 1000 * (t + 1) : 3000), done(n++))
	let pts = context.points(records)
	expect(pts.map((p) => p.cause)).toEqual([...Array(8).fill(undefined), 'pruning checkpoint'])
	let drop = context.points([prompt(1), round(2, 0, 5000), done(3), prompt(4), round(5, 0, 2000)])
	expect(drop[1]!.cause).toBeUndefined()
})

test('a turn from before round records is one approximate point from its turn end', () => {
	let pts = context.points([prompt(1), { type: 'assistant', n: 2, block: { type: 'text', text: 'x' }, ts }, { ...done(3), context: 777 } as HistoryRecord])
	expect(pts).toHaveLength(1)
	expect(pts[0]).toMatchObject({ total: 777, approx: true, turn: 1 })
})
