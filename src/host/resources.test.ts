import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { history } from './history.ts'
import { host } from './host.ts'
import { resources } from './resources.ts'
import { sessions } from './sessions.ts'
import { turns } from './turns.ts'

const saved = { append: history.append, stop: turns.stop, home: process.env.HAL_HOME }
const plenty = { disk: 50e9, memory: 8e9 }
let home = '', notices: { id: string; text: string }[] = [], warnings: string[] = []
let client = { deliver: (event: any) => warnings.push(event.text) } as any
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-resources-`)
	process.env.HAL_HOME = home
	notices = []; warnings = []
	history.append = ((id: string, record: any) => { notices.push({ id, text: record.text }); return record }) as typeof history.append
	host.state.clients.add(client)
})
afterEach(() => {
	resources.stop()
	sessions.closeAll()
	host.state.clients.delete(client)
	history.append = saved.append; turns.stop = saved.stop
	if (saved.home === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = saved.home
	rmSync(home, { recursive: true, force: true })
})
const create = () => sessions.create({ cwd: home, model: 'fake/m' }).id

test('resource transitions reach every open session, including improvement and recovery, without sample repeats', () => {
	let a = create(), b = create()
	resources.check(plenty)
	resources.check({ ...plenty, disk: 3e9 })
	expect(notices.map(n => n.id)).toEqual([a, b])
	expect(notices[0]!.text).toMatch(/^low resources: disk 3\.0 GB free/)
	resources.notice(a)
	resources.check({ ...plenty, disk: 4e9 })
	expect(notices).toHaveLength(2)
	resources.check({ ...plenty, memory: 0.2e9 })
	resources.check({ ...plenty, disk: 4e9 })
	resources.check(plenty)
	expect(notices.filter(n => n.id === a).map(n => n.text.split(':')[0])).toEqual(['low resources', 'critical resources', 'low resources', 'Resources recovered'])
	expect(warnings.map(w => w.split(':')[0])).toEqual(['Low resources', 'Critically low resources', 'Resources recovered'])
	resources.check({ ...plenty, disk: 4e9 })
	expect(notices).toHaveLength(10)
})

test('a session opened or reopened during a shortage learns the current fact once before requesting', () => {
	resources.check({ ...plenty, disk: 3e9 })
	let id = create()
	resources.notice(id); resources.notice(id)
	expect(notices).toHaveLength(1)
	sessions.close(id); sessions.open(id)
	resources.notice(id)
	expect(notices).toHaveLength(2)
	resources.check(plenty)
	let fresh = create()
	resources.notice(fresh)
	expect(notices).toHaveLength(3)
})

test('critical pausing survives a failed history write, and the error stays visible', () => {
	let id = create(), stopped: string[] = []
	let running = turns.state.running
	turns.state.running = new Map([[id, { controller: new AbortController() } as any]])
	turns.stop = (id) => { stopped.push(id) }
	history.append = () => { throw new Error('ENOSPC writing history') }
	try {
		expect(() => resources.check({ ...plenty, disk: 0.2e9 })).toThrow('ENOSPC writing history')
		expect(stopped).toEqual([id])
	} finally { turns.state.running = running }
})

test('critical pressure aborts every controller even if stopping a turn cannot persist', () => {
	let one = new AbortController(), two = new AbortController(), running = turns.state.running
	turns.state.running = new Map([['one', { controller: one } as any], ['two', { controller: two } as any]])
	turns.stop = () => { throw new Error('ENOSPC persisting pause') }
	try {
		resources.check({ ...plenty, memory: .4e9 })
		expect(one.signal.aborted).toBe(true)
		expect(two.signal.aborted).toBe(true)
		expect(warnings.filter((text) => text.includes('ENOSPC persisting pause'))).toHaveLength(2)
	} finally { turns.state.running = running }
})
