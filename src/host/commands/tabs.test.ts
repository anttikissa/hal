import { expect, test } from 'bun:test'
import { client, useHost } from '../host-fixture.test.ts'
import { command } from './tabs.ts'
import { command as historyCommand } from './history.ts'
import { command as resumeCommand } from './resume.ts'
import { sessions } from '../sessions.ts'
import { tabs } from '../tabs.ts'
import { history } from '../history.ts'

useHost()

test('/tabs includes all closed sessions beyond the resume cache and records closure times', () => {
	client()
	let a = sessions.create({ cwd: '/tmp', name: 'First' }).id
	let b = sessions.create({ cwd: '/tmp', name: 'Second' }).id
	let c = sessions.create({ cwd: '/tmp', name: 'Third' }).id
	tabs.insert(a, 0)
	tabs.insert(b, 1)
	tabs.insert(c, 2)
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

test('/resume lists the 20 most recently closed sessions; all lifts the cap', () => {
	client()
	let keep = sessions.create({ cwd: '/tmp', name: 'Keep' }).id
	tabs.insert(keep, 0)
	let ids = Array.from({ length: 22 }, (_, i) => {
		let id = sessions.create({ cwd: '/tmp', name: `Closed ${i}` }).id
		tabs.insert(id, 1)
		tabs.close(id)
		sessions.open(id).closedAt = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
		return id
	})
	let ctx = { sessionId: keep, cwd: '/tmp', model: 'hal/intro', setCwd() {}, setModel() {}, say() {} }
	let rows = (resumeCommand.run('', undefined, ctx) as { say: string }).say.split('\n')
	expect(rows[0]).toContain(ids[21]!)
	expect(rows.filter((r) => r.startsWith('- closed'))).toHaveLength(20)
	expect(rows.join('\n')).not.toContain(`[${ids[0]}]`)
	expect((resumeCommand.run('all', undefined, ctx) as { say: string }).say).toContain(`[${ids[0]}]`)
})

test('/resume --bg publishes reopened tabs without navigating clients', () => {
	let a = client()
	let b = client()
	let keep = sessions.create({ cwd: '/tmp' }).id
	let closed = sessions.create({ cwd: '/tmp' }).id
	tabs.insert(keep, 0)
	tabs.insert(closed, 1)
	tabs.close(closed)
	a.conn.send({ type: 'open', sessionId: keep })
	b.conn.send({ type: 'open', sessionId: keep })
	let ctx = { sessionId: keep, cwd: '/tmp', model: 'hal/intro', setCwd() {}, setModel() {}, say() {} }
	for (let target of [closed, 'last']) {
		a.events.length = b.events.length = 0
		expect(resumeCommand.run(`--bg ${target}`, undefined, ctx)).toEqual({ result: `reopened ${closed}` })
		for (let c of [a, b]) {
			expect(
				c
					.of('tabs')
					.at(-1)
					.tabs.map((t: { id: string }) => t.id),
			).toContain(closed)
			expect(c.of('go')).toHaveLength(0)
		}
		tabs.close(closed)
	}
	for (let args of ['--bg', '--bg all']) {
		expect(resumeCommand.run(args, undefined, ctx)).toHaveProperty('error')
		expect(tabs.file().open).not.toContain(closed)
	}
	expect(resumeCommand.complete!('--bg ', ctx)).toContain(`--bg ${closed}`)
	expect(resumeCommand.run(closed, undefined, ctx)).toEqual({ result: `reopened ${closed}` })
	for (let c of [a, b]) expect(c.of('go').at(-1)).toMatchObject({ tab: closed })
})
