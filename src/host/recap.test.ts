import { afterEach, expect, test } from 'bun:test'
import { settings } from '../common/settings.ts'
import { clock } from './clock.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { recap } from './recap.ts'
import { provider } from './provider.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'
import { client, created, until, useHost } from './host-fixture.test.ts'

useHost(false, false, true)
let saved = { generate: recap.generate, now: clock.now, raw: settings.state.raw }
afterEach(() => { recap.generate = saved.generate; clock.now = saved.now; settings.state.raw = saved.raw })
// The automatic recap is opt-in (sessionRecap, default off).
const optIn = () => void (settings.state.raw = { sessionRecap: true })
function turns(id: string, count = 3): void {
	for (let i = 0; i < count; i++) {
		history.submit(id, `goal ${i}`)
		history.append(id, { type: 'assistant', block: { type: 'text', text: `done ${i}` } })
		history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	}
}

test('recap resolves other tabs without input and persists only in the requester', async () => {
	let c = client(), a = created(c), b = created(c)
	sessions.open(b).name = 'Another session'
	tabs.file().open = [a, b]
	turns(b)
	let before = history.readSync(b).length
	recap.generate = async () => 'Goal completed; waiting for review.'
	expect(recap.targets('2', a)).toEqual([b])
	expect(recap.targets('another session', a)).toEqual([b])
	expect(() => recap.targets('../bad', a)).toThrow('No session matches')
	c.conn.send({ type: 'submit', sessionId: a, text: '/recap all' })
	await until(() => c.of('output').some((e) => e.text.includes('waiting for review')))
	expect(history.readSync(b)).toHaveLength(before)
	expect(history.readSync(a).at(-1)).toMatchObject({ type: 'output', text: expect.stringContaining(b) })
})

test('automatic recap is prepared away, ready on return, and never repeated last', async () => {
	optIn()
	let c = client(), id = created(c)
	turns(id)
	let calls = 0
	recap.generate = async () => { calls++; return 'Built the feature; awaiting review.' }
	c.conn.send({ type: 'visibility', sessionId: id, visible: true })
	c.conn.send({ type: 'visibility', sessionId: id, visible: false })
	await until(() => calls === 1)
	clock.now = () => Date.now() + recap.awayMs
	c.conn.send({ type: 'visibility', sessionId: id, visible: true })
	await until(() => c.of('output').some((e) => e.text.startsWith('Recap: ')))
	expect(calls).toBe(1)
	let end = history.readSync(id).findLast((r) => r.type === 'turn_end')! as any
	history.append(id, { type: 'round', usage: end.usage, ts: end.ts })
	history.append(id, { type: 'turn_end', status: end.status, usage: end.usage, ts: end.ts })
	c.conn.send({ type: 'visibility', sessionId: id, visible: false })
	c.conn.send({ type: 'visibility', sessionId: id, visible: true })
	await Bun.sleep(5)
	expect(c.of('output').filter((e) => e.text.startsWith('Recap: '))).toHaveLength(1)
})

test('automatic recap honors setting, minimum turns and subagent exclusion', async () => {
	let c = client(), id = created(c)
	turns(id, 2)
	optIn()
	expect(await recap.eligible(id)).toBeUndefined()
	turns(id, 1)
	settings.state.raw = {}
	expect(await recap.eligible(id)).toBeUndefined()
	optIn()
	expect(await recap.eligible(id)).toBeDefined()
	sessions.open(id).spawn = 'subagent-leave-open'
	expect(await recap.eligible(id)).toBeUndefined()
})

test('recap failures retain the full provider body and stale success never lands', async () => {
	optIn()
	let c = client(), id = created(c)
	turns(id)
	clock.now = () => Date.now() + recap.awayMs
	recap.generate = async () => { throw new Error('HTTP 400\ncomplete provider body') }
	c.conn.send({ type: 'visibility', sessionId: id, visible: true })
	await until(() => c.of('output').some((e) => e.error))
	expect(c.of('output').at(-1).text).toContain('complete provider body')
	recap.reset()
	let finish!: (text: string) => void
	recap.generate = () => new Promise((resolve) => { finish = resolve })
	c.conn.send({ type: 'visibility', sessionId: id, visible: false })
	await until(() => finish)
	c.conn.send({ type: 'visibility', sessionId: id, visible: true })
	history.append(id, { type: 'output', text: 'New work changed the state.' })
	finish('stale recap')
	await Bun.sleep(5)
	expect(history.readSync(id).some((r) => r.type === 'output' && r.text.includes('stale recap'))).toBe(false)
	host.reset()
})


test('provider recap input and output are bounded and no tools are available', async () => {
	let c = client(), id = created(c), original = provider.stream
	let input: any
	provider.stream = async function* (_model, request) {
		input = request
		yield { type: 'text', text: '😀'.repeat(450) + '\nextra' }
		yield { type: 'done', reason: 'end' }
	}
	try {
		let text = await recap.generate(id, [{ type: 'assistant', block: { type: 'text', text: 'data '.repeat(10_000) }, ts: '' }], new AbortController().signal)
		expect(Array.from(text)).toHaveLength(400)
		expect(input.tools).toEqual([])
		expect(input.messages[0].blocks[0].text.length).toBeLessThan(recap.digestChars + 200)
	} finally { provider.stream = original }
})


test('unknown visibility reports are rejected before recap history access', () => {
	let c = client()
	c.conn.send({ type: 'visibility', sessionId: '../missing', visible: true })
	expect(c.of('rejected').at(-1).reason).toContain('visibility:')
	expect(host.state.clients.values().next().value?.visible).toBeUndefined()
})
