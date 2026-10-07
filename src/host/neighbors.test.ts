import { expect, test } from 'bun:test'
import { clock } from './clock.ts'
import { neighbors } from './neighbors.ts'
import { sessions } from './sessions.ts'

test('neighbors hear each local path once; a final answer frees it for those told; outside paths never', () => {
	let now = clock.now, open = sessions.state.open, state = neighbors.state
	let at = 1_000_000
	try {
		clock.now = () => at
		sessions.state.open = new Map([['neighbor', { cwd: '/p', name: 'Neighbor' } as any]])
		neighbors.state = { seen: new Map(), sent: new Map(), freed: new Map() }
		neighbors.start('neighbor', '/p', ['a.ts', '.git/**', '/tmp/x.log'])
		expect(neighbors.notes('reader', '/p')).toEqual(['[neighbor (Neighbor) declared edits to a.ts]'])
		neighbors.start('neighbor', '/p', ['a.ts', 'b.ts'])
		expect(neighbors.notes('reader', '/p')).toEqual(['[neighbor (Neighbor) declared edits to b.ts]'])
		expect(neighbors.notes('other', '/q')).toEqual([])
		neighbors.finished('neighbor')
		expect(neighbors.notes('reader', '/p')).toEqual(['[neighbor (Neighbor) finished its turn: a.ts, b.ts]'])
		expect(neighbors.notes('stranger', '/p')).toEqual([])
		neighbors.start('neighbor', '/p', ['a.ts'])
		expect(neighbors.notes('reader', '/p')).toEqual(['[neighbor (Neighbor) declared edits to a.ts]'])
		at += neighbors.windowMs + 1
		expect(neighbors.notes('reader', '/p')).toEqual([])
		expect(neighbors.state.seen.size + neighbors.state.sent.size + neighbors.state.freed.size).toBe(0)
	} finally {
		clock.now = now; sessions.state.open = open; neighbors.state = state
	}
})
