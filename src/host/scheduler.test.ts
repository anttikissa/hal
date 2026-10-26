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
	scheduler.tick()
	await until(() => calls.length === 2)
	expect(a.runs).toHaveLength(1)
	expect(b.runs).toHaveLength(1)
	now += 60000
	scheduler.tick()
	expect(a.runs).toHaveLength(1)
	calls[0]!.push({ type: 'done', reason: 'end' })
	await done(1)
	scheduler.tick()
	expect(a.runs).toHaveLength(1)
	command.run(`pause ${a.id}`, undefined, slash.context(owner))
	scheduler.reset()
	expect(scheduler.file().jobs[0]!.paused).toBe(true)
	expect(scheduler.file().jobs[0]!.runs[0]!.result).toBe('completed')
})

test('continued runs keep history, resolve defaults again, and drop trust overrides', async () => {
	mkdirSync(`${testHome()}/.git`)
	writeFileSync(`${testHome()}/AGENTS.md`, 'SCHEDULE_TRUST_MARKER')
	projectContext.decide(testHome(), true)
	let job = add(", history:'continue'")
	scheduler.run(job)
	expect(job.runs[0]!.result).toBeUndefined()
	await until(() => calls.length === 1)
	let id = job.runs[0]!.session!
	expect(calls[0]!.input.system).toContain('SCHEDULE_TRUST_MARKER')
	expect(calls[0]!.input.system).toContain('Timezone: Europe/Helsinki')
	expect(promptCache.interactive(id)).toBe(false)
	await done()
	projectContext.decide(testHome(), false)
	sessions.open(id).projectTrust = projectContext.root(testHome())
	scheduler.run(job)
	await until(() => calls.length === 2)
	expect(job.runs[1]!.session).toBe(id)
	expect(calls[1]!.model).toBe(calls[0]!.model)
	expect(calls[1]!.input.system).not.toContain('SCHEDULE_TRUST_MARKER')
	expect(sessions.open(id).projectTrust).toBeUndefined()
	expect(history.readSync(id).filter((r) => r.type === 'user')).toHaveLength(2)
	await done()
	config.state.data!.model = 'openai/gpt-6-astra'
	scheduler.run(job)
	await until(() => calls.length === 3)
	expect(calls[2]!.model).toBe('openai/gpt-6-astra')
	await done()
})

test('timeout stops work; human takeover disables timeout and autoclose', async () => {
	let job = add(", timeout:'1m', autoclose:true")
	scheduler.run(job)
	await until(() => calls.length === 1)
	now += 60000
	scheduler.tick()
	await until(() => !turns.state.running.size)
	scheduler.tick()
	expect(job.runs[0]!.result).toContain('Timed out')
	scheduler.run(job)
	await until(() => calls.length === 2)
	let id = job.runs[1]!.session!
	let c = client()
	c.conn.send({ type: 'open', sessionId: id })
	c.conn.send({ type: 'submit', sessionId: id, text: '/schedule' })
	now += 120000
	scheduler.tick()
	expect(turns.state.running.has(id)).toBe(true)
	expect(sessions.open(id).autoclose).toBe(false)
	await done()
})

test('restart records uncertain runs without retrying them', async () => {
	let job = add()
	scheduler.run(job)
	await until(() => calls.length === 1)
	let id = job.runs[0]!.session!
	turns.stop(id, 'simulate shutdown')
	await until(() => !turns.state.running.size)
	scheduler.reset()
	scheduler.recover()
	scheduler.tick()
	await turns.recover()
	expect(calls).toHaveLength(1)
	expect(scheduler.file().jobs[0]!.runs[0]!.result).toContain('not retried')
})

test('hal/tool runs an ordinary native tool without a provider', async () => {
	let job = add(", model:'hal/tool', prompt:'HELP'")
	scheduler.run(job)
	await until(() => !turns.state.running.size)
	scheduler.tick()
	expect(calls).toHaveLength(0)
	expect(job.runs[0]!.result).toBe('completed')
	expect(
		history.readSync(job.runs[0]!.session!).some((r) => r.type === 'assistant' && r.block.type === 'tool_call'),
	).toBe(true)
})

test('forms retain defaults, all saved states are listed, and corrupt state is refused', async () => {
	let ctx = slash.context(owner)
	let form = await command.run('add', undefined, ctx)
	expect(form.ask?.fields.find((f) => f.name === 'cwd')).toMatchObject({ initial: testHome() })
	let j = add()
	let result = await command.run(`edit ${j.id} {prompt:'updated', when:'Mon-Fri at 09:00'}`, undefined, ctx)
	expect(result.say).toContain('updated')
	await command.run(`pause ${j.id}`, undefined, ctx)
	expect((await command.run('', undefined, ctx)).say).toContain('Paused')
	expect(command.complete!('resume ', ctx)).toContain(`resume ${j.id}`)
	expect((await command.run('stop', undefined, ctx)).ask?.fields[0]?.name).toBe('job')
	expect((await command.run('edit', { job: String(j.id) }, ctx)).askArgs).toBe(`edit ${j.id}`)
	await command.run(`resume ${j.id}`, undefined, ctx)
	expect((await command.run(String(j.id), undefined, ctx)).say).toContain('Europe/Helsinki')
	let data = ason.stringify({ ...scheduler.file(), jobs: [{ ...j, runs: [{ at: 1, session: '../../outside' }] }] })
	scheduler.reset()
	writeFileSync(`${testHome()}/state/schedule.ason`, data)
	expect(() => scheduler.file()).toThrow('invalid run state')
})
