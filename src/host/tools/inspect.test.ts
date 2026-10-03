import { expect, test } from 'bun:test'
import { client, created, useHost } from '../host-fixture.test.ts'
import { tools } from '../tools.ts'
import { tabs } from '../tabs.ts'

useHost()

const inspect = (sessionId: string, input: Record<string, unknown> = {}) => tools.run(
	{ type: 'tool_call', id: 'i', name: 'inspect', input },
	{ cwd: '/tmp', signal: new AbortController().signal, sessionId },
)

test('a bare call describes only the caller; scope widens it in tab order', async () => {
	let a = client()
	let first = created(a, '/tmp/first')
	let second = created(client(), '/tmp/second')
	let third = created(client(), '/tmp/first')
	// A created session is not automatically a tab; the tab bar is the source of truth.
	tabs.file().open.push(second, first, third)

	let self = (await inspect(first)).output
	expect(self).toContain(`id: ${first} (you)`)
	expect(self).toContain('context: none')
	expect(self).not.toContain(second)

	let project = (await inspect(first, { scope: 'project', fields: 'id,cwd' })).output
	expect(project.split('\n')).toEqual(['id\tcwd', `${first} (you)\t/tmp/first`, `${third}\t/tmp/first`])

	let all = (await inspect(first, { scope: 'all', fields: 'tab,id,color' })).output
	expect(all.indexOf(second)).toBeLessThan(all.indexOf(first))
	expect(all).toMatch(/\t[a-z]+$/m)
})

test('host facts without addresses; unknown values list the valid ones', async () => {
	created(client(), '/tmp/x')
	let out = (await inspect('none', { what: 'host' })).output
	expect(out).toMatch(/^pid: \d+$/m)
	expect(out).toMatch(/^clients: 1$/m)
	expect(out).not.toContain('token')
	let bad = await inspect('none', { fields: 'name,bogus' })
	expect(bad.isError).toBe(true)
	expect(bad.output).toContain('context')
	expect((await inspect('none', { scope: 'everyone' })).output).toContain('self, project, all')
})

test('clients report the terminal size they last sent', async () => {
	let c = client()
	let id = created(c, '/tmp/x')
	c.conn.send({ type: 'screen', cols: 120, rows: 56, term: 'xterm-ghostty, truecolor' })
	c.conn.send({ type: 'screen', cols: 100, rows: 40 })
	let out = (await inspect(id, { what: 'clients', fields: 'size,term,follows' })).output
	expect(out.split('\n')).toEqual(['size: 100x40', 'term: unknown', 'follows: yes'])
})
