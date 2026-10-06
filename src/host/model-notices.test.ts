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
	expect(calls[0]!.input.messages.at(-1).role).toBe('user')
	expect(texts(calls[0]!.input.messages)).toContain('model changed from hal/intro to fake/opus')
	expect(texts(calls[0]!.input.messages)).not.toContain('response was interrupted')
	calls[0]!.push({ type: 'text', text: 'Ready.' }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length)
	expect(c.of('turn-end').at(-1).status).toBe('completed')
	expect((await fresh(id)).items).toEqual(c.views.get(id)!.items)
})

test('changes during streaming follow real tool results without changing earlier request prefixes', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'Inspect.' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'Working.' })
	await until(() => c.of('stream').length)
	slash.change(id, { model: 'fake/m2' })
	slash.change(id, { model: 'fake/m3' })
	history.append(id, { type: 'output', text: 'Rules changed.', change: { name: 'AGENTS.md', what: 'changed', diff: '+new rule' } })
	// The pending next-round message uses the same safe boundary as notices.
	prompts.submit(id, 'Another session update.', undefined, 'interrupt', { from: id, advisory: true })
	calls[0]!.push({ type: 'tool_call', id: 'read', name: 'read', input: { path: '/tmp/this-hal-test-file-does-not-exist' } }, { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	let messages = calls[1]!.input.messages
	expect(messages.slice(0, calls[0]!.input.messages.length)).toEqual(calls[0]!.input.messages)
	let blocks = messages.flatMap((m: any) => m.blocks)
	let call = blocks.findIndex((b: any) => b.type === 'tool_call')
	let result = blocks.findIndex((b: any) => b.type === 'tool_result')
	let notice = blocks.findIndex((b: any) => b.type === 'text' && b.text.includes('changed from fake/m1'))
	expect(result).toBe(call + 1)
	expect(notice).toBeGreaterThan(result)
	expect(texts(messages)).toContain('changed from fake/m1 to fake/m2')
	expect(texts(messages)).toContain('changed from fake/m2 to fake/m3')
	expect(texts(messages)).toContain('Rules changed.')
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
	expect(texts(first).match(/changed from fake\/m1 to fake\/m2/g)).toHaveLength(1)
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
