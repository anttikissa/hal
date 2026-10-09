import './host.ts'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { clock } from './clock.ts'
import { neighbors } from './neighbors.ts'
import { sessions } from './sessions.ts'

test('readers hear declared files modified within a minute, then once when the declaration ends', () => {
	let now = clock.now, open = sessions.state.open, state = neighbors.state
	let dir = mkdtempSync(join(tmpdir(), 'neighbors-')), at = Date.now()
	// Each file's mtime, in seconds before `at`.
	let touch = (name: string, ago: number) => { writeFileSync(join(dir, name), ''); utimesSync(join(dir, name), (at - ago * 1000) / 1000, (at - ago * 1000) / 1000) }
	try {
		clock.now = () => at
		sessions.state.open = new Map(['neighbor', 'reader', 'late'].map((id) => [id, { cwd: dir, name: id === 'neighbor' ? 'Neighbor' : undefined } as any]))
		neighbors.state = { active: new Set(), told: new Map() }
		touch('server.log', 5); touch('old.ts', 3600)
		let server = neighbors.start('neighbor', dir, ['server.log', 'old.ts', 'missing.ts', '.git/**', '/tmp/x.log', '..', `../${basename(dir)}/server.log`])
		expect(neighbors.notes('reader', dir)).toEqual(['[neighbor (Neighbor) modified server.log <1min ago]'])
		expect(neighbors.notes('reader', dir)).toEqual([])
		expect(neighbors.notes('other', '/q')).toEqual([])
		// Who changed a declared file does not matter, nor does a glob.
		touch('a.ts', 1); touch('b.ts', 1)
		let edit = neighbors.start('neighbor', dir, ['*.ts'])
		expect(neighbors.notes('reader', dir)).toEqual(['[neighbor (Neighbor) modified a.ts, b.ts <1min ago]'])
		neighbors.end(edit)
		at += neighbors.lingerMs + 1
		expect(neighbors.notes('reader', dir)).toEqual(['[neighbor (Neighbor) is no longer editing a.ts, b.ts]'])
		// A running call outlives the linger; its end is told however late.
		neighbors.end(server)
		at += 60 * neighbors.lingerMs
		expect(neighbors.notes('reader', dir)).toEqual(['[neighbor (Neighbor) is no longer editing files]'])
		// Activity that ended before a reader's next request is never told.
		touch('c.ts', 0)
		neighbors.end(neighbors.start('neighbor', dir, ['c.ts']))
		at += neighbors.lingerMs + 1
		expect(neighbors.notes('late', dir)).toEqual([])
		expect(neighbors.state.active.size + neighbors.state.told.size).toBe(0)
	} finally {
		clock.now = now; sessions.state.open = open; neighbors.state = state
		rmSync(dir, { recursive: true, force: true })
	}
})
