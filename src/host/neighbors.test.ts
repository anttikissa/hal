import { expect, test } from 'bun:test'
import { clock } from './clock.ts'
import { neighbors } from './neighbors.ts'
import { sessions } from './sessions.ts'

test('readers hear active declarations, then one update when they change or end, however late', () => {
	let now = clock.now, open = sessions.state.open, state = neighbors.state
	let at = 1_000_000
	try {
		clock.now = () => at
		sessions.state.open = new Map(['neighbor', 'reader', 'late'].map((id) => [id, { cwd: '/p', name: id === 'neighbor' ? 'Neighbor' : undefined } as any]))
		neighbors.state = { active: new Set(), told: new Map() }
		let server = neighbors.start('neighbor', '/p', ['server.log', '.git/**', '/tmp/x.log'])
		expect(neighbors.notes('reader', '/p')).toEqual(['[neighbor (Neighbor) may be editing server.log]'])
		let edit = neighbors.start('neighbor', '/p', ['server.log', 'a.ts'])
		expect(neighbors.notes('reader', '/p')).toEqual(['[neighbor (Neighbor) may also be editing a.ts]'])
		neighbors.end(edit)
		at += neighbors.lingerMs
		expect(neighbors.notes('reader', '/p')).toEqual([])
		expect(neighbors.notes('other', '/q')).toEqual([])
		// A running call outlives the linger; the ended one expires.
		at += 10 * neighbors.lingerMs
		expect(neighbors.notes('reader', '/p')).toEqual(['[neighbor (Neighbor) is no longer editing a.ts]'])
		neighbors.end(server)
		at += 60 * neighbors.lingerMs
		expect(neighbors.notes('reader', '/p')).toEqual(['[neighbor (Neighbor) is no longer editing files]'])
		expect(neighbors.notes('reader', '/p')).toEqual([])
		// Activity that ended before a reader's next request is never told.
		neighbors.end(neighbors.start('neighbor', '/p', ['b.ts']))
		at += neighbors.lingerMs + 1
		expect(neighbors.notes('late', '/p')).toEqual([])
		expect(neighbors.state.active.size + neighbors.state.told.size).toBe(0)
	} finally {
		clock.now = now; sessions.state.open = open; neighbors.state = state
	}
})
