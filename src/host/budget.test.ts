import { expect, test } from 'bun:test'
import { config } from './config.ts'
import { snapshots } from './snapshots.ts'
import { settings } from '../common/settings.ts'
import { sessions } from './sessions.ts'
import { subagents } from './subagents.ts'
import { forks } from './forks.ts'
import { command } from './commands/budget.ts'
import { slash } from './slash.ts'
import { client, toolSession, useHost } from './host-fixture.test.ts'

useHost()

const spawn = (owner: string, limit: number, fork = false) => subagents.spawn(owner, { kind: 'subagent-leave-open', task: '', fork, cwd: '/tmp', limit })

test('siblings share ancestor slots without paying their promised budgets upfront', () => {
	let c = client(), root = toolSession(c)
	sessions.open(root).slots = 5
	let a = spawn(root, 3), b = spawn(root, 3)
	expect(sessions.open(root).slots).toBe(3)
	expect(c.views.get(root)!.meta.slots).toBe(3)
	spawn(a, 2)
	spawn(b, 2, true)
	spawn(a, 1)
	expect(sessions.open(root).slots).toBe(0)
	expect(sessions.open(a).slots).toBe(1)
	expect(sessions.open(b).slots).toBe(2)
	let before = sessions.ids()
	expect(() => spawn(b, 0)).toThrow(`session ${root} has 0 spawn slots left`)
	expect(sessions.ids()).toEqual(before)
	expect(sessions.open(b).slots).toBe(2)
	command.run('10', undefined, slash.context(b))
	expect(() => spawn(b, 0)).toThrow(`session ${root} has 0 spawn slots left`)
	command.run('1', undefined, slash.context(root))
	spawn(b, 0)
	expect(sessions.open(root).slots).toBe(0)
	expect(sessions.open(b).slots).toBe(9)
	expect(c.views.get(root)!.meta.slots).toBe(0)
})

test('configuration seeds new budgets and missing counts fall back without changing stored metadata', () => {
	let root = toolSession(client())
	config.update({ subagentSlots: 7 })
	let next = sessions.create({ cwd: '/tmp', model: 'fake/m1' })
	expect(next.slots).toBe(7)
	expect(sessions.open(root).slots).toBe(3)
	delete next.slots
	expect(snapshots.build(next.id).meta.slots).toBe(7)
	expect(next.slots).toBeUndefined()
	expect(() => config.update({ subagentSlots: -1 })).toThrow('expected an integer')
})

test('interactive spawns are free and ordinary forks copy the count into an independent tree', () => {
	let root = toolSession(client())
	sessions.open(root).slots = 0
	let interactive = subagents.spawn(root, { kind: 'interactive', task: '', fork: true, cwd: '/tmp', limit: 99 })
	expect(sessions.open(interactive)).toMatchObject({ parent: root, slots: settings.subagentSlots() })
	expect(sessions.open(interactive).owner).toBeUndefined()
	expect(sessions.open(root).slots).toBe(0)
	command.run('2', undefined, slash.context(root))
	let copy = forks.create(root)
	expect(sessions.open(copy)).toMatchObject({ parent: root, slots: 2 })
	expect(sessions.open(copy).owner).toBeUndefined()
	spawn(copy, 1)
	expect(sessions.open(copy).slots).toBe(1)
	expect(sessions.open(root).slots).toBe(2)
})
