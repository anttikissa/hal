// Context boundaries against the real host (tasks bc, vh): /compact and
// /clear, what the next request holds and what clients show.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { settings } from '../common/settings.ts'
import { compact } from './compact.ts'
import { calls, client, created, fresh, readCall, records, restartHost, shown, toolSession, until, useHost } from './host-fixture.test.ts'
import { history } from './history.ts'
import { models } from './models.ts'

useHost()

type C = ReturnType<typeof client>

// A prompt answered with `answer`; waits for its turn end.
async function ask(c: C, id: string, text: string, answer = `re ${text}`): Promise<void> {
	let ends = c.of('turn-end').length
	c.conn.send({ type: 'submit', sessionId: id, text })
	await until(() => calls.length && c.of('turn-start').length > ends)
	calls.at(-1)!.push({ type: 'text', text: answer }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length > ends)
}

async function command(c: C, id: string, text: string): Promise<void> {
	let outputs = c.events.length
	c.conn.send({ type: 'submit', sessionId: id, text })
	await until(() => c.events.slice(outputs).some((e) => e.type === 'divider' || e.type === 'output'))
}

const text = (m: any) => JSON.stringify(m)

test('/compact: the next request holds the summary and only later records; the transcript stays whole', async () => {
	let c = client()
	let id = created(c)
	for (let i = 1; i <= 5; i++) await ask(c, id, `p${i}`)
	await command(c, id, '/compact')
	await ask(c, id, 'after')
	let input = calls.at(-1)!.input.messages
	expect(input[0].blocks[0].text).toStartWith('Context was compacted')
	expect(input[0].blocks[0].text).toContain(history.file(id))
	expect(input.slice(1).map(text).join()).not.toContain('re p5')
	expect(input.slice(1).map(text).join()).toContain('after')
	let view = shown(c.views.get(id)!.items)!
	expect(view).toContainEqual({ type: 'divider', text: 'context compacted (5 prompts summarised)' })
	expect(view.filter((i) => i.type === 'prompt').length).toBe(6)
	expect(shown((await fresh(id)).items)).toEqual(view)
	// A new host rebuilds the very same input.
	let before = await history.messages(id)
	restartHost()
	history.open(id)
	expect(await history.messages(id)).toEqual(before)
})

test('/compact with nothing to compact says so, and twice in a row too', async () => {
	let c = client()
	let id = created(c)
	await command(c, id, '/compact')
	expect(c.of('output').at(-1).text).toBe('nothing to compact')
	await ask(c, id, 'p1')
	await command(c, id, '/compact')
	await command(c, id, '/compact')
	expect(c.of('divider').length).toBe(1)
	expect(c.of('output').at(-1).text).toBe('nothing to compact')
})

test('/compact while a turn runs answers that it is busy', async () => {
	let c = client()
	let id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'p1' })
	await until(() => calls.length)
	await command(c, id, '/compact')
	expect(c.of('output').at(-1)).toMatchObject({ error: true, text: expect.stringContaining('busy') })
	calls[0]!.push({ type: 'done', reason: 'end' })
})

test('/clear: the next request holds only later records; a compact after it summarises only what followed', async () => {
	let c = client()
	let id = created(c)
	await ask(c, id, 'before')
	await command(c, id, '/clear')
	await ask(c, id, 'after')
	let input = calls.at(-1)!.input.messages
	expect(input.length).toBe(1)
	expect(text(input)).toContain('after')
	expect(text(input)).not.toContain('before')
	expect(shown(c.views.get(id)!.items)).toContainEqual({ type: 'divider', text: 'context cleared' })
	await command(c, id, '/clear')
	await command(c, id, '/clear')
	expect(c.of('output').at(-1).text).toBe('the context is already empty')
	await ask(c, id, 'later')
	await command(c, id, '/compact')
	await ask(c, id, 'last')
	let summary = calls.at(-1)!.input.messages[0].blocks[0].text
	expect(summary).toContain('user: later')
	expect(summary).not.toContain('after')
})

describe('automatic compaction (task mq)', () => {
	let window = models.contextWindow
	beforeEach(() => {
		models.contextWindow = () => 1000
		settings.state.raw = {}
	})
	afterEach(() => {
		models.contextWindow = window
		settings.state.raw = {}
	})

	// A turn whose first round asks for a tool, having taken in `input`.
	async function fullRound(c: C, input: number): Promise<string> {
		let id = toolSession(c)
		await ask(c, id, 'p1')
		c.conn.send({ type: 'submit', sessionId: id, text: 'p2' })
		await until(() => calls.length === 2)
		calls[1]!.push(readCall(), { type: 'usage', usage: { input: input - 100, cacheRead: 100 } }, { type: 'done', reason: 'tool_use' })
		await until(() => calls.length === 3)
		return id
	}

	test('at the threshold it compacts between rounds, after the results, and says so', async () => {
		let c = client()
		let id = await fullRound(c, 850)
		expect(calls[2]!.input.messages[0].blocks[0].text).toStartWith('Context was compacted')
		expect(calls[2]!.input.messages.at(-1).blocks[0].text).toContain('p2')
		let types = (await records(id)).map((r) => r.type)
		let at = types.lastIndexOf('compact')
		expect(types[at - 1]).toBe('user')
		expect((await records(id))[at - 1]).toMatchObject({ blocks: [{ type: 'tool_result' }] })
		expect(calls[2]!.input.messages[0].blocks[0].text).not.toContain('user: p2')
		calls[2]!.push({ type: 'text', text: 'done' }, { type: 'usage', usage: { input: 100 } }, { type: 'done', reason: 'end' })
		await until(() => c.of('turn-end').length === 2)
		// The next turn starts from the small context: no second compact.
		await ask(c, id, 'p3')
		expect(c.of('divider').length).toBe(1)
	})

	test('with compactAt 0 it never compacts', async () => {
		settings.state.raw = { compactAt: 0 }
		let c = client()
		let id = await fullRound(c, 990)
		expect(calls[2]!.input.messages[0].blocks[0].text).not.toStartWith('Context was compacted')
		expect((await records(id)).some((r) => r.type === 'compact')).toBe(false)
		calls[2]!.push({ type: 'done', reason: 'end' })
	})

	test('below the threshold it does not compact', async () => {
		let id = await fullRound(client(), 840)
		expect((await records(id)).some((r) => r.type === 'compact')).toBe(false)
		calls[2]!.push({ type: 'done', reason: 'end' })
	})

	test('first-round compaction keeps the new prompt and image outside the summary, also after restart', async () => {
		let c = client()
		let id = created(c)
		c.conn.send({ type: 'submit', sessionId: id, text: 'old context' })
		await until(() => calls.length === 1)
		calls[0]!.push({ type: 'usage', usage: { input: 900 } }, { type: 'done', reason: 'end' })
		await until(() => c.of('turn-end').length === 1)
		let png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('IHDR-image')]).toString('base64')
		c.conn.send({ type: 'attach', sessionId: id, mediaType: 'image/png', data: png, id: 'picture' })
		let marker = c.of('attached').at(-1).marker
		c.conn.send({ type: 'submit', sessionId: id, text: `new question ${marker}` })
		await until(() => calls.length === 2)
		let messages = calls[1]!.input.messages
		expect(messages[0].blocks[0].text).toContain('old context')
		expect(messages[0].blocks[0].text).not.toContain('new question')
		expect(messages.at(-1).blocks).toMatchObject([{ type: 'text', text: expect.stringContaining('new question') }, { type: 'image', mediaType: 'image/png' }])
		expect(messages.at(-1).blocks[1].blob).toBe(c.of('attached').at(-1).blob)
		restartHost()
		history.open(id)
		expect(await history.messages(id)).toEqual(messages)
	})
	test('a prompt too long compacts and retries once, then the turn fails with the provider message', async () => {
		let c = client()
		let id = created(c)
		await ask(c, id, 'p1')
		c.conn.send({ type: 'submit', sessionId: id, text: 'p2' })
		await until(() => calls.length === 2)
		let refusal = { type: 'error' as const, message: 'prompt is too long: 250000 tokens > 200000 maximum', status: 400 }
		calls[1]!.push({ ...refusal })
		await until(() => calls.length === 3)
		expect(calls[2]!.input.messages[0].blocks[0].text).toStartWith('Context was compacted')
		calls[2]!.push({ ...refusal })
		await until(() => c.of('turn-end').length === 2)
		expect(c.of('turn-end').at(-1)).toMatchObject({ status: 'error', error: expect.stringContaining('prompt is too long') })
		expect(calls.length).toBe(3)
	})

	test('too long is recognised by provider wording and status', () => {
		expect(compact.tooLong({ type: 'error', message: 'x', body: '{"error":{"code":"context_length_exceeded"}}', status: 400 })).toBe(true)
		expect(compact.tooLong({ type: 'error', message: 'request too large', status: 413 })).toBe(true)
		expect(compact.tooLong({ type: 'error', message: 'request too large', status: 500 })).toBe(false)
		expect(compact.tooLong({ type: 'error', message: 'invalid tool schema', status: 400 })).toBe(false)
	})
})
