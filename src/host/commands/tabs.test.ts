import { expect, test } from 'bun:test'
import { client, useHost } from '../host-fixture.test.ts'
import { command } from './tabs.ts'
import { command as historyCommand } from './history.ts'
import { sessions } from '../sessions.ts'
import { tabs } from '../tabs.ts'
import { history } from '../history.ts'

useHost()

test('/tabs includes all closed sessions beyond the resume cache and records closure times', () => {
	client()
	let a = sessions.create({ cwd: '/tmp', name: 'First' }).id
	let b = sessions.create({ cwd: '/tmp', name: 'Second' }).id
	let c = sessions.create({ cwd: '/tmp', name: 'Third' }).id
	tabs.insert(a, 0); tabs.insert(b, 1); tabs.insert(c, 2)
	let ctx = { sessionId: a, cwd: '/tmp', model: 'hal/intro', setCwd() {}, setModel() {}, say() {} }
	expect(tabs.close(b)).toBeUndefined()
	sessions.open(b).closedAt = '2026-01-01T00:00:00.000Z'
	expect(tabs.close(c)).toBeUndefined()
	tabs.file().closed = []
	let output = command.run('', undefined, ctx) as { say: string }
	expect(output.say).toContain(`tab 1  [${a}](`)
	expect(output.say).toContain('(you)')
	expect(output.say).not.toContain(b)
	let all = (command.run('all', undefined, ctx) as { say: string }).say
	expect(all.indexOf(c)).toBeLessThan(all.indexOf(b))
	expect(all).toContain('closed 2026-01-01T00:00:00.000Z')
	expect(historyCommand.run('', undefined, ctx)).toEqual({ say: history.file(a) })
})
