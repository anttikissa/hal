import { expect, test } from 'bun:test'
import { commandList } from '../common/commands/list.ts'
import { keyHelp } from '../common/key-help.ts'
import { commands } from './commands.ts'
import { command as help } from './commands/help.ts'
import { drafts } from './drafts.ts'
import { history } from './history.ts'
import { calls, client, toolSession, until, useHost } from './host-fixture.test.ts'
import { sessions } from './sessions.ts'
import { slash } from './slash.ts'
import { status } from './status.ts'
import { tabs } from './tabs.ts'

useHost()

test('fork snapshots completed blocks, leaves the parent running, and focuses only its followers', async () => {
	let c = client(), other = client()
	let parent = toolSession(c)
	tabs.insert(parent, 0)
	let unrelated = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id
	tabs.insert(unrelated, 1)
	other.conn.send({ type: 'open', sessionId: unrelated })
	sessions.open(parent).name = 'Work'
	sessions.open(parent).slots = 0
	c.conn.send({ type: 'submit', sessionId: parent, text: 'remember plum' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'unfinished stream' })
	await until(() => history.live(parent)?.blocks.length)
	drafts.set(parent, 'half-typed idea')
	await slash.runCommand(parent, 'fork', '')
	let child = tabs.file().open[1]!
	expect(drafts.get(child).text).toBe('half-typed idea')
	expect(drafts.get(parent).text).toBe('half-typed idea')
	expect(tabs.file().open).toEqual([parent, child, unrelated])
	expect(sessions.open(child)).toMatchObject({ cwd: sessions.open(parent).cwd, model: 'fake/m1', name: 'Work (fork)' })
	expect(sessions.open(child).parent).toBeUndefined()
	expect(sessions.open(child).spawn).toBeUndefined()
	expect(sessions.open(child).slots).toBeUndefined()
	expect(sessions.open(parent).slots).toBe(0)
	expect(status.stateOf(parent).type).toBe('running')
	expect(status.stateOf(child).type).toBe('idle')
	expect(JSON.stringify(history.readSync(child))).toContain('remember plum')
	expect(JSON.stringify(history.readSync(child))).not.toContain('unfinished stream')
	expect(history.readSync(child).at(-1)).toMatchObject({ type: 'output', text: expect.stringContaining(parent) })
	expect(history.readSync(parent).at(-1)).toMatchObject({ type: 'output', text: expect.stringContaining(child) })
	expect(c.of('go').at(-1).tab).toBe(child)
	expect(other.of('go')).toEqual([])
	c.conn.send({ type: 'open', sessionId: child })
	c.conn.send({ type: 'submit', sessionId: child, text: 'carry on' })
	await until(() => calls.length === 2)
	calls[1]!.push({ type: 'text', text: 'done' }, { type: 'done', reason: 'end' })
	await until(() => status.stateOf(child).type === 'idle')
	expect(tabs.file().open).toContain(child)
	expect(status.inboxOf(parent)).toEqual([])
})

test('branch works and completes but help and keys expose only fork', async () => {
	let c = client(), parent = toolSession(c)
	tabs.insert(parent, 0)
	let ctx = slash.context(parent)
	expect(commands.complete('/bra', ctx)).toContain('/branch ')
	expect((await help.run('', undefined, ctx)).say).not.toContain('/branch')
	expect((await help.run('', undefined, ctx)).say).toContain('/fork')
	expect(keyHelp.render()).toContain('/fork')
	expect(keyHelp.render()).not.toContain('/branch')
	expect(commandList.byKey(keyHelp.parse('ctrl-b'))?.name).toBe('fork')
	sessions.open(parent).name = 'x'.repeat(60)
	await slash.runCommand(parent, 'branch', '')
	expect(tabs.file().open).toHaveLength(2)
	expect(sessions.open(tabs.file().open[1]!).name).toBe(`${'x'.repeat(53)} (fork)`)
})
