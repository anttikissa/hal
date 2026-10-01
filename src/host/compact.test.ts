// Context boundaries against the real host (tasks bc, vh): /compact and
// /clear, what the next request holds and what clients show.
import { describe, expect, test } from 'bun:test'
import { compact } from './compact.ts'
import { calls, client, created, fresh, restartHost, shown, until, useHost } from './host-fixture.test.ts'
import { history } from './history.ts'

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
	let view = shown(c.views.get(id)!.items)!
	expect(view.filter((i) => i.type === 'prompt').map((i: any) => i.text)).toEqual(['after'])
	expect(view[0]).toMatchObject({ type: 'output', text: 'context cleared' })
	expect(shown((await fresh(id)).items)).toEqual(view)
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

test('/clear right after /compact drops the summary too', async () => {
	let c = client()
	let id = created(c)
	await ask(c, id, 'before')
	await command(c, id, '/compact')
	await command(c, id, '/clear')
	expect(c.of('output').filter((o: any) => o.text === 'the context is already empty')).toEqual([])
	await ask(c, id, 'after')
	expect(text(calls.at(-1)!.input.messages)).not.toContain('before')
})

describe('a prompt too long (task mq)', () => {
	const refusal = { type: 'error' as const, message: 'prompt is too long: 250000 tokens > 200000 maximum', status: 400 }

	test('the retry keeps the new prompt and image outside the summary, also after restart', async () => {
		let c = client()
		let id = created(c)
		await ask(c, id, 'old context')
		let png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('IHDR-image')]).toString('base64')
		c.conn.send({ type: 'attach', sessionId: id, mediaType: 'image/png', data: png, id: 'picture' })
		let marker = c.of('attached').at(-1).marker
		c.conn.send({ type: 'submit', sessionId: id, text: `new question ${marker}` })
		await until(() => calls.length === 2)
		calls[1]!.push({ ...refusal })
		await until(() => calls.length === 3)
		let messages = calls[2]!.input.messages
		expect(messages[0].blocks[0].text).toContain('old context')
		expect(messages[0].blocks[0].text).not.toContain('new question')
		expect(messages.at(-1).blocks).toMatchObject([{ type: 'text', text: expect.stringContaining('new question') }, { type: 'image', mediaType: 'image/png' }])
		expect(messages.at(-1).blocks[1].blob).toBe(c.of('attached').at(-1).blob)
		restartHost()
		history.open(id)
		expect(await history.messages(id)).toEqual(messages)
	})

	test('a paused turn keeps its original prompt verbatim when Enter resumes and is refused', async () => {
		let c = client(), id = created(c)
		await ask(c, id, 'earlier turn')
		c.conn.send({ type: 'submit', sessionId: id, text: 'original prompt of this turn' })
		await until(() => calls.length === 2)
		c.conn.send({ type: 'pause', sessionId: id })
		await until(() => c.of('turn-end').length === 2)
		// Enter resumes the same turn; its prompt predates the paused turn_end.
		c.conn.send({ type: 'continue', sessionId: id })
		await until(() => calls.length === 3)
		calls[2]!.push({ ...refusal })
		await until(() => calls.length === 4)
		let input = calls[3]!.input.messages
		expect(input[0].blocks[0].text).toStartWith('Context was compacted')
		expect(input[0].blocks[0].text).toContain('earlier turn')
		expect(input[0].blocks[0].text).not.toContain('original prompt of this turn')
		expect(input.at(-1).blocks[0].text).toContain('original prompt of this turn')
		let onDisk = history.readSync(id)
		let compacted = onDisk.findLast((r) => r.type === 'compact')
		if (compacted?.type !== 'compact') throw new Error('expected a compact boundary')
		expect(compacted.keep).toContain(onDisk.find((r) => r.type === 'user' && r.blocks.some((b) => b.type === 'text' && b.text.includes('original prompt of this turn')))?.n)
		calls[3]!.push({ type: 'done', reason: 'end' })
	})

	test('multiple prompts across pauses stay verbatim after the boundary', async () => {
		let id = created(client())
		history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'old turn' }] })
		history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
		let originals = []
		for (let text of ['first prompt', 'steered prompt', 'after second pause']) {
			originals.push(history.append(id, { type: 'user', blocks: [{ type: 'text', text }] }).n!)
			if (text !== 'after second pause') {
				history.append(id, { type: 'turn_end', status: 'paused', usage: {} })
				history.append(id, { type: 'continue' })
			}
		}
		expect(compact.run(id, true)).toBeDefined()
		let boundary = history.readSync(id).at(-1)
		if (boundary?.type !== 'compact') throw new Error('expected compact')
		expect(boundary.keep).toEqual(originals)
		let messages = await history.messages(id)
		expect(JSON.stringify(messages[0])).toContain('old turn')
		for (let [i, prompt] of ['first prompt', 'steered prompt', 'after second pause'].entries()) expect(JSON.stringify(messages[i + 1])).toContain(prompt)
	})
	test('a prompt too long compacts and retries once, then the turn fails with the provider message', async () => {
		let c = client()
		let id = created(c)
		await ask(c, id, 'p1')
		c.conn.send({ type: 'submit', sessionId: id, text: 'p2' })
		await until(() => calls.length === 2)
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
