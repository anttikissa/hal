import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { command } from './commands/todo.ts'
import { history } from './history.ts'
import { calls, client, testHome, toolSession, until, useHost } from './host-fixture.test.ts'
import { sessions } from './sessions.ts'
import { slash } from './slash.ts'
import { status } from './status.ts'
import { tabs } from './tabs.ts'

useHost()

function git(...args: string[]): string {
	let result = Bun.spawnSync(['git', ...args], { cwd: testHome(), stdout: 'pipe', stderr: 'pipe' })
	if (result.exitCode) throw new Error(result.stderr.toString())
	return result.stdout.toString()
}

test('TODO append handles a missing newline and commits only TODO.md, preserving another staged file', async () => {
	git('init', '-q')
	git('config', 'user.name', 'Test')
	git('config', 'user.email', 'test@example.invalid')
	git('config', 'commit.gpgsign', 'false')
	let parent = toolSession(client())
	writeFileSync(`${testHome()}/TODO.md`, '# TODO\n- [x] already done\n- [ ] open checkbox\n- plain item')
	writeFileSync(`${testHome()}/other.txt`, 'unrelated')
	git('add', '--', 'other.txt')
	let reply = await command.run('fix a bug', undefined, slash.context(parent))
	expect(reply.error).toBeUndefined()
	expect(readFileSync(`${testHome()}/TODO.md`, 'utf8')).toEndWith('- plain item\n- fix a bug\n')
	expect(git('show', '--format=', '--name-only', 'HEAD').trim()).toBe('TODO.md')
	expect(git('diff', '--cached', '--name-only').trim()).toBe('other.txt')
	let message = git('log', '-1', '--format=%B')
	expect(message).toStartWith('TODO: fix a bug\n')
	expect(message).toContain(`Implemented by: fake/m1\nSession: ${parent}`)
	let listing = await command.run('', undefined, slash.context(parent))
	expect(listing.say).toBe('- [ ] open checkbox\n- plain item\n- fix a bug')
})

test('a Git failure says the TODO was saved and does not lose it', async () => {
	let parent = toolSession(client())
	writeFileSync(`${testHome()}/TODO.md`, '')
	let reply = await command.run('keep me', undefined, slash.context(parent))
	expect(reply.error).toContain('Added to')
	expect(reply.error).toContain('git add failed')
	expect(readFileSync(`${testHome()}/TODO.md`, 'utf8')).toBe('- keep me\n')
})

test('without TODO.md an idle session files the item itself, and bare todo never starts work', async () => {
	let parent = toolSession(client())
	let ctx = slash.context(parent)
	expect((await command.run('', undefined, ctx)).error).toContain('No TODO.md')
	expect(calls).toHaveLength(0)
	await command.run('write docs', undefined, ctx)
	await until(() => calls.length === 1)
	expect(JSON.stringify(calls[0]!.input.messages)).toContain('Add a TODO item to this project: write docs')
})

test('without TODO.md a busy session delegates to a subagent for one slot, and refuses with none', async () => {
	let c = client(), parent = toolSession(c)
	tabs.insert(parent, 0)
	sessions.open(parent).slots = 1
	c.conn.send({ type: 'submit', sessionId: parent, text: 'keep working' })
	await until(() => calls.length === 1)
	expect((await command.run('write docs', undefined, slash.context(parent))).error).toBeUndefined()
	await until(() => calls.length === 2)
	let child = tabs.file().open[1]!
	expect(status.stateOf(parent).type).toBe('running')
	expect(status.inboxOf(parent)).toEqual([])
	expect(sessions.open(parent).slots).toBe(0)
	expect(sessions.open(child)).toMatchObject({ parent, spawn: 'subagent', slots: 0 })
	expect(JSON.stringify(calls[1]!.input.messages)).not.toContain('keep working')
	expect(JSON.stringify(calls[1]!.input.messages)).toContain('Add a TODO item to this project: write docs')
	expect(JSON.stringify(history.readSync(parent))).not.toContain('Add a TODO item')
	expect((await command.run('again', undefined, slash.context(parent))).error).toContain('0 left')
	expect(tabs.file().open).toHaveLength(2)
})
