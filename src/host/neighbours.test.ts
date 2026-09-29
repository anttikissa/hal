import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { clock } from './clock.ts'
import { neighbours } from './neighbours.ts'
import { sessions } from './sessions.ts'
import { tools } from './tools.ts'

let home = '', cwd = ''
const savedHome = process.env.HAL_HOME, savedNow = clock.now
let t = 1_000_000
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-neighbours-`)
	process.env.HAL_HOME = home
	cwd = `${home}/repo`
	mkdirSync(cwd)
	clock.now = () => t
	neighbours.state.seen.clear()
	neighbours.state.sent.clear()
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

test('a neighbour editing the same directory is heard once, shared paths first, then not after 15 minutes', async () => {
	let a = sessions.create({ cwd, model: 'fake/m' }).id
	let b = sessions.create({ cwd, model: 'fake/m' }).id
	await bash(a, 'true', ['x.ts', 'y.ts'])
	expect(await bash(b, 'echo hi')).toContain(`[${a} (${sessions.open(a).name}) is editing`)
	expect(await bash(b, 'echo hi')).not.toContain('editing')
	t += 180_000
	let note = await bash(b, 'echo hi', ['y.ts'])
	expect(note).toContain(`[${a} (${sessions.open(a).name}) is editing y.ts (also yours), x.ts; 3 min ago]`)
	// Unchanged content is not repeated, though the age moved.
	t += 60_000
	expect(await bash(b, 'echo hi', ['y.ts'])).not.toContain('editing')
	// The other side hears about b, never about itself, and nothing once the window has passed.
	let heard = await bash(a, 'echo hi')
	expect(heard).toContain(`[${b} (${sessions.open(b).name}) is editing y.ts (also yours)`)
	expect(heard).not.toContain(`[${a}`)
	t += 20 * 60_000
	expect(await bash(b, 'echo hi')).not.toContain('editing')
})
