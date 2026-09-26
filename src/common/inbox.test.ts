import { expect, test } from 'bun:test'
import { inbox } from './inbox.ts'
import type { HistoryRecord } from './replay.ts'
import type { SessionState } from './states.ts'

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

test('every waiting message says why it waits, naming what ends the wait', () => {
	let steer = { id: 'a', text: 'x' }
	let queued = { id: 'b', text: 'y', queue: true as const }
	let running: SessionState = { type: 'running', phase: 'streaming' }
	expect(inbox.label(running, steer)).not.toEqual(inbox.label(running, queued))
	expect(inbox.label({ type: 'paused' }, queued)).toMatch(/paused.*Enter/)
	expect(inbox.label({ type: 'blocked', reason: 'log in' }, steer)).toMatch(/log in/)
	expect(inbox.label({ type: 'error', message: '400' }, queued)).toMatch(/400/)
	expect(inbox.label({ type: 'retrying', at: ts, reason: '529' }, steer)).toMatch(/529/)
})
