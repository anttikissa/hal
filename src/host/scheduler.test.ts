// Saved jobs use normal turns while preventing overlap and unsafe restart retries.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { calls, client, created, testHome, until, useHost } from './host-fixture.test.ts'
import { command } from './commands/schedule.ts'
import { clock } from './clock.ts'
import { history } from './history.ts'
import { scheduler } from './scheduler.ts'
import { slash } from './slash.ts'
import { sessions } from './sessions.ts'
import { turns } from './turns.ts'
import { projectContext } from './project-context.ts'
import { promptCache } from './prompt-cache.ts'
import { tabs } from './tabs.ts'
import { config } from './config.ts'
import { providers } from './providers.ts'
import { ason } from '../common/ason.ts'

useHost()
let now = 0,
	original = clock.now,
	owner = ''
beforeEach(() => {
	providers.init()
	now = Date.parse('2026-10-26T12:00:00Z')
	original = clock.now
	clock.now = () => now
	owner = created(client(), testHome())
})
afterEach(() => {
	scheduler.reset()
	clock.now = original
})
function add(extra = '') {
	command.run(`add {when:'1m', prompt:'check', timezone:'Europe/Helsinki'${extra}}`, undefined, slash.context(owner))
	return scheduler.file().jobs.at(-1)!
}
async function done(n = calls.length - 1) {
	calls[n]!.push({ type: 'text', text: 'done' }, { type: 'done', reason: 'end' })
	await until(() => !turns.state.running.size)
	scheduler.tick()
}

test('one catchup, no overlap, independent jobs, and persisted controls', async () => {
	let a = add(),
		b = add()
	now += 600000
	scheduler.tick(true)
	scheduler.tick()
	await until(() => calls.length === 2)
	let first = a.run!.session
	expect(b.run!.session).not.toBe(first)
	now += 60000
	scheduler.tick()
	expect(a.run!.session).toBe(first)
	calls[0]!.push({ type: 'done', reason: 'end' })
	await done(1)
	scheduler.tick()
	expect(a.run!.session).toBe(first)
	expect((await command.run(`remove ${b.id}`, undefined, slash.context(owner))).say).toContain('Removed')
	expect(scheduler.file().jobs).toHaveLength(1)
	command.run(`pause ${a.id}`, undefined, slash.context(owner))
	scheduler.reset()
	expect(scheduler.file().jobs[0]!.paused).toBe(true)
	expect(scheduler.file().jobs[0]!.run!.result).toBe('completed')
})

test('fresh runs resolve defaults again and respect revoked project trust', async () => {
	mkdirSync(`${testHome()}/.git`)
	writeFileSync(`${testHome()}/AGENTS.md`, 'SCHEDULE_TRUST_MARKER')
	projectContext.decide(testHome(), true)
	tabs.insert(owner, 0)
	let job = add()
	scheduler.run(job)
	await until(() => calls.length === 1)
	let first = job.run!.session!
	expect(calls[0]!.input.system).toContain('SCHEDULE_TRUST_MARKER')
	expect(calls[0]!.input.system).toContain('Timezone: Europe/Helsinki')
	expect(promptCache.interactive(first)).toBe(false)
	expect(sessions.open(first).autoclose).toBe(true)
	await done()
	expect(tabs.file().open).not.toContain(first)
	projectContext.decide(testHome(), false)
	config.state.data!.model = 'openai/gpt-6-astra'
	scheduler.run(job)
	await until(() => calls.length === 2)
	expect(job.run!.session).not.toBe(first)
	expect(calls[1]!.model).toBe('openai/gpt-6-astra')
	expect(calls[1]!.input.system).not.toContain('SCHEDULE_TRUST_MARKER')
	expect(history.readSync(job.run!.session!).filter((r) => r.type === 'user')).toHaveLength(1)
	let c = client()
	c.conn.send({ type: 'open', sessionId: job.run!.session! })
	c.conn.send({ type: 'submit', sessionId: job.run!.session!, text: '/schedule' })
	expect(scheduler.owned(job.run!.session!)).toBeUndefined()
	await done()
})

test('restart records uncertain runs without retrying them', async () => {
	let job = add()
	scheduler.run(job)
	await until(() => calls.length === 1)
	let id = job.run!.session!
	turns.stop(id, 'simulate shutdown')
	await until(() => !turns.state.running.size)
	scheduler.reset()
	scheduler.tick(true)
	scheduler.tick()
	await turns.recover()
	expect(calls).toHaveLength(1)
	expect(scheduler.file().jobs[0]!.run!.result).toContain('not retried')
})

test('hal/tool runs an ordinary native tool without a provider', async () => {
	let job = add(", model:'hal/tool', prompt:'HELP'")
	scheduler.run(job)
	await until(() => !turns.state.running.size)
	scheduler.tick()
	expect(calls).toHaveLength(0)
	expect(job.run!.result).toBe('completed')
	expect(history.readSync(job.run!.session!).some((r) => r.type === 'assistant' && r.block.type === 'tool_call')).toBe(
		true,
	)
})

test('job controls persist and corrupt session references are refused', async () => {
	let ctx = slash.context(owner)
	let j = add(", prompt:'updated', when:'Mon-Fri at 09:00'")
	expect((await command.run('', undefined, ctx)).say).toContain('updated')
	await command.run(`pause ${j.id}`, undefined, ctx)
	expect((await command.run('', undefined, ctx)).say).toContain('Paused')
	expect(command.complete!('resume ', ctx)).toContain(`resume ${j.id}`)
	expect(command.complete!('add {', ctx)).toContain('add {when: ')
	expect(command.complete!("add {model: 'def", ctx)).toContain("add {model: 'default'")
	await command.run(`resume ${j.id}`, undefined, ctx)
	expect((await command.run('', undefined, ctx)).say).toContain('Europe/Helsinki')
	let data = ason.stringify({ ...scheduler.file(), jobs: [{ ...j, run: { session: '../../outside' } }] })
	scheduler.reset()
	writeFileSync(`${testHome()}/state/schedule.ason`, data)
	expect(() => scheduler.file()).toThrow('invalid run state')
})
