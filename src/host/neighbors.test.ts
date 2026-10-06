import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { clock } from './clock.ts'
import { neighbors } from './neighbors.ts'
import { sessions } from './sessions.ts'
import { tools } from './tools.ts'

let home = '', cwd = ''
const savedHome = process.env.HAL_HOME, savedNow = clock.now
let t = 1_000_000
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-neighbors-`)
	process.env.HAL_HOME = home
	cwd = `${home}/repo`
	mkdirSync(cwd)
	t = 1_000_000
	clock.now = () => t
	neighbors.state.seen.clear()
	neighbors.state.sent.clear()
})
afterEach(() => {
	sessions.closeAll()
	clock.now = savedNow
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})
const create = () => sessions.create({ cwd, model: 'fake/m' }).id
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })

test('request sampling reports changed facts once with local time and running state', () => {
	let a = create(), b = create(), name = sessions.open(a).name
	neighbors.start(a, cwd, ['x.ts', 'y.ts']); neighbors.end(a)
	expect(neighbors.notes(b, cwd)).toEqual([`[${a} (${name}) declared edits to x.ts, y.ts at ${hhmm(t)}; call finished]`])
	expect(neighbors.notes(b, cwd)).toEqual([])
	t += 60_000
	neighbors.start(a, cwd, ['z.ts'])
	expect(neighbors.notes(b, cwd)[0]).toContain(`z.ts, x.ts, y.ts at ${hhmm(t)}; call running]`)
	neighbors.end(a)
	expect(neighbors.notes(b, cwd)[0]).toContain('call finished]')
	expect(neighbors.notes(a, cwd)).toEqual([])
})

test('expired paths and closed or moved sessions prune activity and delivery fingerprints', () => {
	let a = create(), b = create()
	neighbors.start(a, cwd, ['old.ts']); neighbors.end(a)
	neighbors.notes(b, cwd)
	t += neighbors.windowMs + 1
	neighbors.start(a, cwd, ['fresh.ts']); neighbors.end(a)
	expect(neighbors.notes(b, cwd)[0]).toContain('fresh.ts')
	expect([...neighbors.state.seen.get(a)!.paths.keys()]).toEqual(['fresh.ts'])
	sessions.close(b)
	neighbors.prune()
	expect(neighbors.state.sent.size).toBe(0)
	sessions.open(b)
	expect(neighbors.notes(b, cwd)).toHaveLength(1)
	sessions.open(a).cwd = home
	neighbors.prune()
	expect(neighbors.state.seen.size).toBe(0)
	expect(neighbors.state.sent.size).toBe(0)
})

test('path display stays bounded and expired activity is forgotten and announced afresh', () => {
	let a = create(), b = create()
	neighbors.start(a, cwd, Array.from({ length: 8 }, (_, i) => `${i}.ts`)); neighbors.end(a)
	expect(neighbors.notes(b, cwd)[0]).toContain('0.ts, 1.ts, 2.ts, 3.ts, 4.ts, 3 more')
	t += neighbors.windowMs + 1
	expect(neighbors.notes(b, cwd)).toEqual([])
	expect(neighbors.state.seen.size).toBe(0)
	expect(neighbors.state.sent.size).toBe(0)
	neighbors.start(a, cwd, ['0.ts']); neighbors.end(a)
	expect(neighbors.notes(b, cwd)).toHaveLength(1)
})

test('bash records declarations but returns raw command output without consuming neighbor notices', async () => {
	let a = create(), b = create()
	neighbors.start(a, cwd, ['x.ts']); neighbors.end(a)
	let ctx = { sessionId: b, cwd, signal: new AbortController().signal, callId: 'c' }
	let result = await tools.run({ type: 'tool_call', id: 'c', name: 'bash', input: { command: 'printf hi', description: 'x', modifies: ['y.ts'] } }, ctx)
	expect(result.output).toBe('[exit 0]\nhi')
	expect(neighbors.notes(b, cwd)).toHaveLength(1)
	expect(neighbors.notes(a, cwd)[0]).toContain('y.ts')
})


test('an old background call ending does not mark a newer call finished after its paths expire', () => {
	let a = create(), b = create()
	neighbors.start(a, cwd, ['old.ts'])
	t += neighbors.windowMs + 1
	expect(neighbors.notes(b, cwd)).toEqual([])
	neighbors.start(a, cwd, ['fresh.ts'])
	neighbors.end(a)
	expect(neighbors.notes(b, cwd)[0]).toContain('fresh.ts at ' + hhmm(t) + '; call running]')
	expect(neighbors.notes(b, cwd)).toEqual([])
	neighbors.end(a)
	expect(neighbors.notes(b, cwd)[0]).toContain('call finished]')
})
