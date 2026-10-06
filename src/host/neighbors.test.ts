import { expect, test } from 'bun:test'
import { clock } from './clock.ts'
import { neighbors } from './neighbors.ts'
import { sessions } from './sessions.ts'

test('neighbor facts deliver once, change on completion and expire', () => {
	let now = clock.now, open = sessions.state.open, seen = neighbors.state.seen, sent = neighbors.state.sent
	let at = 1_000_000
	try {
		clock.now = () => at
		sessions.state.open = new Map([['neighbor', { cwd: '/tmp', name: 'Neighbor' } as any]])
		neighbors.state.seen = new Map(); neighbors.state.sent = new Map()
		neighbors.start('neighbor', '/tmp', ['a.ts'])
		expect(neighbors.notes('reader', '/tmp').join()).toContain('call running')
		expect(neighbors.notes('reader', '/tmp')).toEqual([])
		neighbors.end('neighbor')
		expect(neighbors.notes('reader', '/tmp').join()).toContain('call finished')
		at += neighbors.windowMs + 1
		expect(neighbors.notes('reader', '/tmp')).toEqual([])
	} finally {
		clock.now = now; sessions.state.open = open
		neighbors.state.seen = seen; neighbors.state.sent = sent
	}
})
