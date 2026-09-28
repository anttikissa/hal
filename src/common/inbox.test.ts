import { expect, test } from 'bun:test'
import { inbox } from './inbox.ts'
import type { HistoryRecord } from './replay.ts'

const ts = '2026-01-01T00:00:00.000Z'
const waiting = (id: string, queue = false): HistoryRecord => ({ type: 'inbox', id, text: `text ${id}`, ...(queue ? { queue: true as const } : {}), ts })
const delivered = (...ids: string[]): HistoryRecord => ({ type: 'user', blocks: ids.map((id) => ({ type: 'text' as const, text: `text ${id}` })), inbox: ids, ts })

test('the inbox is every message not yet delivered, in the order sent', () => {
	expect(inbox.pending([])).toEqual([])
	let records = [waiting('a'), waiting('b', true), waiting('c'), delivered('a', 'c')]
	expect(inbox.pending(records)).toEqual([{ id: 'b', text: 'text b', queue: true }])
	expect(inbox.pending([...records, waiting('d')]).map((m) => m.id)).toEqual(['b', 'd'])
	expect(inbox.pending([...records, delivered('b')])).toEqual([])
})

