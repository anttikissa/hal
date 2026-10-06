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
const bash = async (sessionId: string, command: string, modifies?: string[]) => {
	let ctx = { sessionId, cwd, signal: new AbortController().signal, callId: 'c' }
	return (await tools.run({ type: 'tool_call', id: 'c', name: 'bash', input: { command, description: 'x', modifies } }, ctx)).output
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })

test('notes report declared activity once, with time and call state, and stop after 15 minutes', async () => {
	let a = sessions.create({ cwd, model: 'fake/m' }).id
	let b = sessions.create({ cwd, model: 'fake/m' }).id
	let name = sessions.open(a).name
	await bash(a, 'true', ['x.ts', 'y.ts'])
	let note = await bash(b, 'echo hi', ['y.ts'])
	expect(note).toContain(`[${a} (${name}) declared edits to x.ts, y.ts at ${hhmm(t)}; call finished]`)
	expect(note).not.toContain('also yours')
	expect(await bash(b, 'echo hi')).not.toContain('declared')
	// A running call says so; its end changes the note.
	t += 60_000
	let started = t
	let running = bash(a, 'sleep 0.3', ['z.ts'])
	await Bun.sleep(100)
	expect(await bash(b, 'echo hi')).toContain(`declared edits to z.ts, x.ts, y.ts at ${hhmm(started)}; call running]`)
	let heard = await running
	expect(await bash(b, 'echo hi')).toContain('call finished]')
	expect(heard).toContain(`[${b} (${sessions.open(b).name}) declared edits to y.ts`)
	expect(heard).not.toContain(`[${a}`)
	t += 20 * 60_000
	expect(await bash(b, 'echo hi')).not.toContain('declared')
})
