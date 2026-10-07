// Autoclose belongs to every session, not to a spawn kind (task p87).
import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { paths } from './paths.ts'
import { protocol } from '../common/protocol.ts'
import { autoclose } from './autoclose.ts'
import { calls, client, toolSession, until, useHost } from './host-fixture.test.ts'
import { history } from './history.ts'
import { jobs } from './jobs.ts'
import { liveFiles } from './live-file.ts'
import { prompts } from './prompts.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { subagents } from './subagents.ts'
import { tabs } from './tabs.ts'

useHost()

function ordinary() {
	let c = client()
	let keep = toolSession(c)
	tabs.insert(keep, 0)
	let id = tabs.create('/tmp', keep, true)
	c.conn.send({ type: 'open', sessionId: id })
	return { c, id, keep }
}

test('ordinary autoclose survives its first prompt and closes after a final answer', async () => {
	let { c, id, keep } = ordinary()
	c.conn.send({ type: 'submit', sessionId: id, text: 'do this job' })
	await until(() => calls.length === 1)
	expect(sessions.open(id).autoclose).toBe(true)
	calls[0]!.push({ type: 'text', text: 'Done. <summary>All done</summary>' }, { type: 'done', reason: 'end' })
	await until(() => !tabs.file().open.includes(id))
	expect(tabs.file().open).toEqual([keep])
})

test('autoclose command records each change once, pushes metadata and persists it', async () => {
	let { c, id } = ordinary()
	c.conn.send({ type: 'submit', sessionId: id, text: '/autoclose off' })
	await until(() => sessions.open(id).autoclose === false)
	c.conn.send({ type: 'submit', sessionId: id, text: '/autoclose on' })
	await until(() => sessions.open(id).autoclose === true)
	c.conn.send({ type: 'submit', sessionId: id, text: '/autoclose on' })
	c.conn.send({ type: 'submit', sessionId: id, text: '/autoclose' })
	c.conn.send({ type: 'submit', sessionId: id, text: '/autoclose nonsense' })
	await until(() => c.of('output').some((e) => e.error))
	expect(history.readSync(id).filter((r) => r.type === 'output' && r.text.includes('→')).map((r) => r.type === 'output' && r.text)).toEqual(['Autoclose: on → off', 'Autoclose: off → on'])
	expect(c.of('meta').at(-1)?.meta.autoclose).toBe(true)
	expect(c.views.get(id)?.items.some((r) => r.type === 'output' && r.text === 'Autoclose: off → on')).toBe(true)
	let stored = sessions.load(id, false)
	expect(stored.autoclose).toBe(true)
	liveFiles.close(stored)
})

for (let delivery of ['steer', 'soft-steer'] as const) test(`human ${delivery} promotes existing work without rewriting spawn kind`, async () => {
	let { id } = ordinary()
	let child = subagents.spawn(id, { kind: 'subagent', task: 'work', fork: false, cwd: '/tmp', limit: 0 })
	await until(() => calls.length === 1)
	prompts.submit(child, 'human intervention', undefined, delivery)
	expect(sessions.open(child)).toMatchObject({ autoclose: false, spawn: 'subagent' })
	expect(history.readSync(child).filter((r) => r.type === 'output' && r.text === 'Autoclose: on → off')).toHaveLength(1)
})

test('questions and errors leave ordinary autoclose tabs open', async () => {
	let { c, id } = ordinary()
	c.conn.send({ type: 'submit', sessionId: id, text: 'choose' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: '<question>Which choice?</question>' }, { type: 'done', reason: 'end' })
	await until(() => status.stateOf(id).type === 'idle')
	expect(tabs.file().open).toContain(id)
	// A queued reply waits behind the question without promoting the session.
	prompts.submit(id, 'follow-up', undefined, 'queue')
	expect(sessions.open(id).autoclose).toBe(true)
	expect(status.inboxOf(id)).toHaveLength(1)
	let failed = ordinary()
	failed.c.conn.send({ type: 'submit', sessionId: failed.id, text: 'failing work' })
	await until(() => calls.length === 2)
	calls[1]!.push({ type: 'error', message: 'bad request', status: 400 })
	await until(() => status.stateOf(failed.id).type === 'error')
	expect(sessions.open(failed.id).autoclose).toBe(true)
	expect(tabs.file().open).toContain(failed.id)
})

test('unfinished jobs and running subagents prevent ordinary autoclose', async () => {
	let { id } = ordinary()
	let child = subagents.spawn(id, { kind: 'subagent-leave-open', task: 'work', fork: false, cwd: '/tmp', limit: 0 })
	await until(() => calls.length === 1)
	expect(sessions.open(child).autoclose).toBe(false)
	autoclose.finished(id)
	expect(tabs.file().open).toContain(id)
	// Isolate the background-job guard once the child is no longer running.
	tabs.close(child)
	jobs.state.running.set('job', { sessionId: id } as any)
	try {
		autoclose.finished(id)
		expect(tabs.file().open).toContain(id)
	} finally { jobs.state.running.delete('job') }
})

test('autoclose initialization rejects non-boolean wire and stored values', () => {
	for (let type of ['create', 'tab-new']) expect(protocol.invalid({ type, cwd: '/tmp', autoclose: 'on' })).toContain('autoclose must be a boolean')
	let { id } = ordinary()
	expect(() => sessions.validate(id, { ...sessions.open(id), autoclose: 'on' })).toThrow('invalid autoclose')
})

test('older metadata materializes spawn defaults without overriding explicit autoclose', () => {
	let { id } = ordinary()
	let meta = { ...sessions.open(id), spawn: 'subagent' as const }
	delete meta.autoclose
	sessions.close(id)
	let path = `${paths.sessionDir(id)}/session.ason`
	writeFileSync(path, ason.stringify(meta))
	expect(sessions.open(id).autoclose).toBe(true)
	expect(ason.parse(readFileSync(path, 'utf8'))).toMatchObject({ autoclose: true })
	sessions.open(id).autoclose = false
	sessions.close(id)
	expect(sessions.open(id).autoclose).toBe(false)
})
