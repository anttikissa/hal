// Unit tests for per-row height estimation and virtual-scroll window math
// used by Transcript.tsx (task tzg).

import { describe, expect, test } from 'bun:test'
import type { Row } from './transcript-rows.ts'
import { cardRows } from './card-rows.ts'

const collapsedTool = (key: string): Row => ({
	key,
	at: Number(key),
	item: { type: 'tool', key, id: `call_${key}`, name: 'bash', input: { command: 'ls' } },
})

const reply = (key: string, text: string): Row => ({
	key,
	at: Number(key),
	item: { type: 'text', key, text },
})

describe('cardRows height and virtual-scroll math', () => {
	test('collapsed and one-row cards estimate at one line plus margin; open cards scale with wrapped lines', () => {
		let lh = 20,
			cols = 40
		expect(cardRows.height(collapsedTool('1'), false, cols, lh)).toBe(42)
		expect(
			cardRows.height({ key: '2', at: 2, item: { type: 'divider', key: '2', text: 'cleared' } }, true, cols, lh),
		).toBe(42)
		let short = cardRows.height(reply('3', 'Short answer.'), true, cols, lh)
		let tall = cardRows.height(reply('4', 'A'.repeat(400)), true, cols, lh)
		expect(short).toBe(53 + 20)
		expect(tall).toBe(53 + 10 * 20)
	})

	test('space estimates collapsed earlier rows individually without inflating from tall newest rows', () => {
		let lh = 20,
			cols = 40
		let rows: Row[] = [
			...Array.from({ length: 80 }, (_, i) => collapsedTool(String(i))),
			...Array.from({ length: 40 }, (_, i) => reply(String(80 + i), 'Line.\n'.repeat(20))),
		]
		let heightOf = (r: Row) => cardRows.height(r, r.item.type === 'text', cols, lh)
		// 80 collapsed rows at 42 px each = 3360 px, unaffected by the 40 tall rows after them.
		expect(cardRows.space(rows, 80, 0, heightOf)).toBe(80 * 42)
		// Unfetched history uses the earliest 100 loaded rows (80 collapsed + 20 tall), not only the newest 40.
		let withUnfetched = cardRows.space(rows, 80, 50, heightOf)
		let earliest100Avg = (80 * 42 + 20 * (53 + 20 * 20)) / 100
		expect(withUnfetched).toBe(Math.round(80 * 42 + 50 * earliest100Avg))
	})

	test('locate maps a coordinate in the unmounted pad to its row or -1 above loaded history', () => {
		let heights = [42, 42, 200, 42]
		let rows = heights.map((_, i) => collapsedTool(String(i)))
		let heightOf = (r: Row) => heights[r.at]!
		let pad = cardRows.span(rows, 0, 4, heightOf) // 326
		expect(pad).toBe(326)
		// Walking back from start=4: row 3 covers [284,326), row 2 [84,284), row 1 [42,84), row 0 [0,42).
		expect(cardRows.locate(rows, 4, pad, 300, heightOf)).toBe(3)
		expect(cardRows.locate(rows, 4, pad, 150, heightOf)).toBe(2)
		expect(cardRows.locate(rows, 4, pad, 50, heightOf)).toBe(1)
		expect(cardRows.locate(rows, 4, pad, 10, heightOf)).toBe(0)
		expect(cardRows.locate(rows, 4, pad + 500, 100, heightOf)).toBe(-1)
	})
})
