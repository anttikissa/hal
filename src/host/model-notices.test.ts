// Next-round host facts preserve provider input and survive context transitions.
import { expect, test } from 'bun:test'
import { states } from '../common/states.ts'
import { transcript } from '../common/transcript.ts'
import { history } from './history.ts'
import { compact } from './compact.ts'
import { prompts } from './prompts.ts'
import { slash } from './slash.ts'
import { turns } from './turns.ts'
import { calls, client, created, fresh, restartHost, until, useHost } from './host-fixture.test.ts'

useHost()

const texts = (messages: any[]) => messages.flatMap((m) => m.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text)).join('\n')

test('switching from the intro and skipping its question sends the change on the first real request', async () => {
	let c = client()
	c.conn.send({ type: 'create', cwd: '/tmp/w', model: 'hal/intro' })
	let id = c.of('snapshot').at(-1).sessionId
	c.conn.send({ type: 'submit', sessionId: id, text: 'Help with the intro.' })
	await until(() => transcript.question(c.views.get(id)))
	slash.change(id, { model: 'fake/opus' })
	c.conn.send({ type: 'pause', sessionId: id }) // Skip, not a user pause.
	await until(() => calls.length)
	expect(calls).toHaveLength(1)
	expect(calls[0]!.model).toBe('fake/opus')
	expect(calls[0]!.input.system).toContain('fake/opus')
	expect(texts(calls[0]!.input.messages)).not.toContain('model changed from')
	expect(texts(calls[0]!.input.messages)).not.toContain('response was interrupted')
	calls[0]!.push({ type: 'text', text: 'Ready.' }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length)
	expect(c.of('turn-end').at(-1).status).toBe('completed')
	expect((await fresh(id)).items).toEqual(c.views.get(id)!.items)
})

test('changes interrupt streaming, settle pending calls and preserve earlier request prefixes', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'Inspect.' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'Working.' })
	await until(() => c.of('stream').length)
	calls[0]!.push({ type: 'tool_call', id: 'read', name: 'read', input: { path: '/tmp/this-hal-test-file-does-not-exist' } })
	await until(() => c.of('stream').some((e) => e.event.type === 'tool_call'))
	slash.change(id, { model: 'fake/m2' })
	slash.change(id, { model: 'fake/m3' })
	history.append(id, { type: 'output', text: 'Rules changed.', change: { name: 'AGENTS.md', what: 'changed', diff: '+new rule' } })
	// The pending next-round message uses the same safe boundary as notices.
	prompts.submit(id, 'Another session update.', undefined, 'steer', { from: id, advisory: true })
	// Late old-model output must not enter the continuation.
	calls[0]!.push({ type: 'text', text: 'LATE OUTPUT' }, { type: 'done', reason: 'end' })
	await until(() => calls.length === 2)
	expect(calls[1]!.model).toBe('fake/m3')
	let messages = calls[1]!.input.messages
	expect(messages.slice(0, calls[0]!.input.messages.length)).toEqual(calls[0]!.input.messages)
	let blocks = messages.flatMap((m: any) => m.blocks)
	let call = blocks.findIndex((b: any) => b.type === 'tool_call')
	let result = blocks.findIndex((b: any) => b.type === 'tool_result')
	let notice = blocks.findIndex((b: any) => b.type === 'text' && b.text.includes('Continue your unfinished response'))
	expect(result).toBe(call + 1)
	expect(notice).toBeGreaterThan(result)
	expect(calls[1]!.input.system).toContain('fake/m3')
	expect(texts(messages)).not.toContain('model changed from')
	expect(texts(messages)).toContain('Rules changed.')
	expect(texts(messages)).toContain('Continue your unfinished response')
	expect(texts(messages)).not.toContain('LATE OUTPUT')
	expect(texts(messages)).toContain('Another session update.')
	calls[1]!.push({ type: 'text', text: 'Done.' }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length)
	let before = await history.messages(id)
	restartHost()
	expect(await history.messages(id)).toEqual(before)
})

test('notice delivery remains once across compact, prompt edits and recovery without waking an idle turn', async () => {
	let c = client(), id = created(c)
	history.submit(id, 'Earlier prompt.')
	history.append(id, { type: 'assistant', block: { type: 'text', text: 'Earlier answer.' }, model: 'fake/m1' })
	history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	slash.change(id, { model: 'fake/m2' })
	compact.run(id)
	expect(states.fromHistory(history.readSync(id))).toEqual({ type: 'idle' })
	await turns.recover()
	expect(calls).toHaveLength(0)
	let first = await history.messages(id)
	expect(texts(first)).not.toContain('model changed from')
	restartHost()
	expect(await history.messages(id)).toEqual(first)
	// Editing a prompt keeps instruction changes, without keeping the old answer.
	history.submit(id, 'Typo.')
	history.append(id, { type: 'output', text: 'New instructions.', change: { name: 'AGENTS.md', what: 'changed', diff: '+rule' } })
	history.append(id, { type: 'assistant', block: { type: 'text', text: 'Discarded answer.' } })
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'Corrected.' }], replaces: true })
	let edited = texts(await history.messages(id))
	expect(edited).toContain('New instructions.')
	expect(edited).toContain('Corrected.')
	expect(edited).not.toContain('Discarded answer.')
})

test('absolute context crossings reach the next round once and re-arm after decreases and compaction', async () => {
	let c = client(), id = created(c)
	let notices = () => history.readSync(id).flatMap((r) => r.type === 'notice' && r.text.startsWith('Context usage crossed') ? [r] : [])
	c.conn.send({ type: 'submit', sessionId: id, text: 'Work.' })
	let levels = [149_999, 150_000, 180_000, 200_000, 250_000, 260_000, 149_999, 251_000]
	let counts = [0, 1, 1, 2, 3, 3, 3, 4]
	for (let [i, input] of levels.entries()) {
		await until(() => calls.length === i + 1)
		let before = calls[i]!.input.messages
		calls[i]!.push({ type: 'tool_call', id: `t${i}`, name: 'nope', input: {} }, { type: 'usage', usage: { input: input - 100_000, cacheRead: 90_000, cacheWrite: 10_000, output: 1 } }, { type: 'done', reason: 'tool_use' })
		await until(() => calls.length === i + 2)
		expect(notices()).toHaveLength(counts[i]!)
		let after = calls[i + 1]!.input.messages
		expect(after.slice(0, before.length)).toEqual(before)
		if (counts[i]! > (counts[i - 1] ?? 0)) {
			let text = notices().at(-1)!.text
			expect(text).toContain(`${input} input tokens`)
			expect(texts(after).split(text)).toHaveLength(2)
			let blocks = after.flatMap((m: any) => m.blocks)
			expect(blocks.findLastIndex((b: any) => b.type === 'text' && b.text.includes(text))).toBeGreaterThan(blocks.findLastIndex((b: any) => b.type === 'tool_result'))
		}
	}
	expect(notices().at(-1)!.text).toContain('150k, 200k, 250k')
	calls.at(-1)!.push({ type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length === 1)
	let before = await history.messages(id)
	restartHost()
	expect(await history.messages(id)).toEqual(before)
	expect(calls).toHaveLength(levels.length + 1)
	c = client()
	c.conn.send({ type: 'open', sessionId: id })
	compact.run(id)
	c.conn.send({ type: 'submit', sessionId: id, text: 'Continue.' })
	await until(() => calls.length === levels.length + 2)
	calls.at(-1)!.push({ type: 'usage', usage: { input: 250_000 } }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length === 1)
	expect(notices()).toHaveLength(5)
	expect(notices().at(-1)!.text).toContain('150k, 200k, 250k')
	expect(calls).toHaveLength(levels.length + 2)
	expect(texts(await history.messages(id))).toContain(notices().at(-1)!.text)
})
