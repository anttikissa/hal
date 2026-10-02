import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { markdown } from '../common/markdown.ts'
import { replay } from '../common/replay.ts'
import { greetings } from './greetings.ts'
import { titles } from '../common/titles.ts'
import { calls, client, created, fresh, restartHost, testHome, until, useHost } from './host-fixture.test.ts'
import { history } from './history.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { subagents, type Spawn } from './subagents.ts'
import { tabs } from './tabs.ts'

useHost(false, true)
const random = greetings.random
afterEach(() => { greetings.random = random })

test('arrival periods use only valid user-local time, including boundaries and daylight saving', () => {
	for (let [time, expected] of [
		['00:00', 'neutral'], ['06:59', 'neutral'], ['07:00', 'morning'], ['11:59', 'morning'],
		['12:00', 'afternoon'], ['17:59', 'afternoon'], ['18:00', 'evening'], ['22:59', 'evening'], ['23:00', 'neutral'],
	] as const) expect(greetings.period('Etc/UTC', Date.parse(`2026-06-01T${time}:00Z`))).toBe(expected)
	let summer = Date.parse('2026-06-01T05:00:00Z')
	expect(greetings.period('Europe/Paris', summer)).toBe('morning')
	expect(greetings.period('Europe/Paris', Date.parse('2026-01-01T05:00:00Z'))).toBe('neutral')
	for (let zone of [undefined, '', 'Not specified', 'invalid/zone', '+03:00']) expect(greetings.period(zone, summer)).toBe('neutral')
})

test('authored choices vary, names are optional data, and missing timezone stays neutral', () => {
	let original = greetings.random
	let samples = (profile: string) => Array.from({ length: 100 }, (_, i) => {
		greetings.random = () => i / 100
		return greetings.choose(profile)
	})
	try {
		let named = samples('Name: Sample Person')
		expect(named.some((s) => s.includes('Sample Person'))).toBe(true)
		expect(named.some((s) => !s.includes('Sample Person'))).toBe(true)
		let absent = samples('')
		for (let name of ['', 'Not specified', '<your name>', 'unknown', '\x1b[31mInjected', 'A\u202eB']) {
			expect(samples(`Name: ${name}`)).toEqual(absent)
		}
		expect(absent.every((s) => !/morning|afternoon|evening|night|\{name\}/i.test(s))).toBe(true)
		let unsafe = 'A **bold** &lt;script&gt; [link](https://example.com)'
		let rendered = markdown.inline(greetings.name(unsafe)!)
		expect(rendered.map((r) => r.text).join('')).toBe(unsafe)
		expect(rendered.every((r) => !r.bold && !r.italic && !r.code && !r.href)).toBe(true)
		greetings.random = () => 0
		let first = greetings.choose('')
		expect(greetings.choose('', first)).not.toBe(first)
	} finally { greetings.random = original }
})

test('new interactive tabs have one shared durable output, no provider turn, and no immediate repeat after restart', async () => {
	greetings.random = () => 0
	let a = client()
	a.conn.send({ type: 'tab-start', cwd: '/tmp' })
	let intro = tabs.file().open[0]!
	expect(sessions.open(intro).model).toBe('hal/intro')
	expect(history.readSync(intro)).toEqual([])
	a.conn.send({ type: 'tab-new', cwd: '/tmp' })
	let id = tabs.file().open[1]!
	a.conn.send({ type: 'open', sessionId: id })
	await until(() => a.views.has(id))
	let records = history.readSync(id)
	expect(records).toHaveLength(1)
	expect(records[0]?.type).toBe('output')
	expect(replay.toMessages(records)).toEqual([])
	expect(replay.withoutCommands(records)).toEqual([])
	expect(status.stateOf(id).type).toBe('idle')
	expect(calls).toHaveLength(0)
	let shown = a.views.get(id)!.items
	expect(titles.who(shown[0]!)).toBe('Hal (synthetic)')
	expect((await fresh(id)).items).toEqual(shown)
	let model = sessions.open(id).model
	// Reopening is not another arrival, even after changing the profile.
	writeFileSync(`${testHome()}/USER.md`, 'Name: A Different Example\nTimezone: Etc/UTC\n')
	restartHost()
	expect((await fresh(id)).items).toEqual(shown)
	expect(sessions.open(id).model).toBe(model)
	expect(history.readSync(id)).toEqual(records)
	let b = client()
	let next = created(b)
	expect(history.readSync(next)[0]).not.toMatchObject({ text: (records[0] as { text: string }).text })
	b.conn.send({ type: 'submit', sessionId: next, text: 'Only this request' })
	await until(() => calls.length === 1)
	expect(calls[0]!.input.messages).toHaveLength(1)
	expect(JSON.stringify(calls[0]!.input.messages)).not.toContain((history.readSync(next)[0] as { text: string }).text)
})

test('restored empty sessions and task-bearing, forked or subagent sessions receive no new greeting', async () => {
	let restored = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id
	expect((await fresh(restored)).items).toEqual([])
	let base: Spawn = { kind: 'interactive', task: '', fork: false, cwd: '/tmp', limit: 0 }
	sessions.open(restored).slots = 10
	let blank = subagents.spawn(restored, base)
	expect(history.readSync(blank).map((r) => r.type)).toEqual(['output'])
	for (let extra of [{ task: 'A supplied task' }, { kind: 'subagent' as const, task: 'Work' }, { kind: 'subagent-leave-open' as const, task: 'Work' }]) {
		let id = subagents.spawn(restored, { ...base, ...extra })
		expect(history.readSync(id).some((r) => r.type === 'output')).toBe(false)
	}
	let fork = subagents.spawn(restored, { ...base, fork: true })
	// A fork has its ordinary provenance output, but no arrival.
	expect(history.readSync(fork).filter((r) => r.type === 'output')).toHaveLength(1)
	let intro = subagents.spawn(restored, { ...base, model: 'hal/intro' })
	expect(history.readSync(intro)).toEqual([])
})
