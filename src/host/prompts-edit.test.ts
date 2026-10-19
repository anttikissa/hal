// Edits of what the user sent (prompts.ts): the last prompt, and inbox
// messages still waiting or already delivered.

import { expect, test } from 'bun:test'
import type { StreamEvent } from '../common/blocks.ts'
import { history } from './history.ts'
import {
	amending,
	calls,
	client,
	created,
	fresh,
	readCall,
	records,
	restartHost,
	stamped,
	toolSession,
	until,
	useHost,
	shown,
} from './host-fixture.test.ts'
import { inboxOf, texts } from './prompts-fixture.test.ts'
import { prompts } from './prompts.ts'
import { tools } from './tools.ts'
import { turns } from './turns.ts'

useHost()

// ── Editing the last prompt (tasks/j1/states.md) ──

// Up while the model works: the client pauses the turn, then sends the edit.
async function pauseAndEdit(a: ReturnType<typeof client>, id: string, text: string) {
	a.conn.send({ type: 'pause', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: amending(id, text) })
}

test('/edit replaces a prompt quietly; /edit undo, even mid-turn, restores it with its partial output, paused', async () => {
	let a = client()
	let id = toolSession(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'what did I ntoe?' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'You no' })
	await until(() => a.views.get(id)!.items.at(-1)?.type === 'text')
	let n = history.readSync(id).findLast((r) => r.type === 'user')!.n
	a.conn.send({ type: 'pause', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: `/edit u${n}\nwhat did I note?`, id: 'edit-1' })
	await until(() => calls.length === 2)
	expect(a.of('prompt').at(-1)).toMatchObject({ command: 'edit-1' })
	expect(history.readSync(id).some((r) => r.type === 'command')).toBe(false)
	calls[1]!.push({ type: 'text', text: 'Milk.' })
	await until(() => a.views.get(id)!.items.some((i) => i.type === 'text' && i.text === 'Milk.'))
	a.conn.send({ type: 'submit', sessionId: id, text: '/edit undo' })
	await until(() => a.views.get(id)!.items.some((i) => i.type === 'text' && i.text === 'You no'))
	let view = await fresh(id)
	expect(view).toEqual(a.views.get(id)!)
	expect(shown(view.items)).toEqual([
		{ type: 'prompt', text: 'what did I ntoe?', interactive: true },
		{ type: 'text', text: 'You no', interrupted: true },
		{ type: 'turn-end', status: 'paused' },
		{ type: 'command', text: '/edit undo', output: `Edit undone: prompt u${n} and its partial output are back.` },
	])
	expect(view.state.type).toBe('paused')
})

test('an edit after only reading replaces the prompt: the model sees it as if written that way', async () => {
	let a = client()
	let id = toolSession(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'hello' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'what did I ntoe?' })
	await until(() => calls.length === 2)
	calls[1]!.push({ type: 'text', text: 'Let me look.' }, readCall(), { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 3)
	calls[2]!.push({ type: 'text', text: 'You no' })
	await until(() => a.views.get(id)!.items.at(-1)?.type === 'text')
	await pauseAndEdit(a, id, 'what did I note?')
	await until(() => calls.length === 4)
	let expected = [
		...calls[1]!.input.messages.slice(0, -1),
		{ role: 'user', blocks: [{ type: 'text', text: stamped('what did I note\\?') }] },
	]
	expect(calls[3]!.input.messages).toEqual(expected)
	calls[3]!.push({ type: 'text', text: 'Milk.' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 3)
	let view = await fresh(id)
	expect(view).toEqual(a.views.get(id)!)
	expect(shown(view.items.slice(3))).toEqual([
		{ type: 'prompt', text: 'what did I note?', edited: true },
		{ type: 'text', text: 'Milk.' },
		{ type: 'turn-end', status: 'completed' },
	])
	// History is only appended to: the first attempt is still there.
	expect(
		(await records(id)).some(
			(r) => r.type === 'user' && r.blocks.some((b) => b.type === 'text' && b.text === 'what did I ntoe?'),
		),
	).toBe(true)
	// And the next turn builds on the edit.
	a.conn.send({ type: 'submit', sessionId: id, text: 'thanks' })
	await until(() => calls.length === 5)
	expect(calls[4]!.input.messages.slice(0, 4)).toEqual([
		...expected,
		{ role: 'assistant', blocks: [{ type: 'text', text: 'Milk.' }] },
	])
})

test('an edit after a tool with side effects keeps history and is sent on top', async () => {
	let origRun = tools.run
	tools.run = async (call) => ({ type: 'tool_result', id: call.id, output: '[exit 0]\n' })
	try {
		let a = client()
		let id = created(a)
		a.conn.send({ type: 'submit', sessionId: id, text: 'clean up' })
		await until(() => calls.length === 1)
		let rm: StreamEvent = {
			type: 'tool_call',
			id: 'b1',
			name: 'bash',
			input: { command: 'rm x', description: 'Delete x' },
		}
		calls[0]!.push(rm, { type: 'done', reason: 'tool_use' })
		await until(() => calls.length === 2)
		await pauseAndEdit(a, id, 'clean up, but keep x')
		await until(() => calls.length === 3)
		let msgs = calls[2]!.input.messages
		expect(msgs.slice(0, calls[1]!.input.messages.length)).toEqual(calls[1]!.input.messages)
		expect(JSON.stringify(msgs.at(-2))).toContain('The user paused the turn.')
		expect(msgs.at(-1).blocks[0].text).toEqual(stamped('clean up, but keep x'))
		calls[2]!.push({ type: 'done', reason: 'end' })
		await until(() => a.of('turn-end').length === 2)
		expect(await fresh(id)).toEqual(a.views.get(id)!)
		expect(shown(a.views.get(id)!.items.filter((i) => i.type === 'prompt'))).toEqual([
			{ type: 'prompt', text: 'clean up', interactive: true },
			{ type: 'prompt', text: 'clean up, but keep x' },
		])
	} finally {
		tools.run = origRun
	}
})

test('an edit sent while the paused turn is still stopping waits for it to end', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'wrnog' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'partial' })
	await until(() => a.of('stream').length)
	// Both arrive before the aborted stream has wound down.
	await pauseAndEdit(a, id, 'right')
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages).toEqual([{ role: 'user', blocks: [{ type: 'text', text: stamped('right') }] }])
	calls[1]!.push({ type: 'text', text: 'ok' }, { type: 'done', reason: 'end' })
	await until(() => history.readSync(id).at(-1)?.type === 'turn_end')
	expect((await records(id)).map((r) => r.type)).toEqual([
		'user',
		'assistant',
		'turn_end',
		'rebase',
		'user',
		'assistant',
		'turn_end',
	])
	expect(await fresh(id)).toEqual(a.views.get(id)!)
	expect(shown(a.views.get(id)!.items)).toEqual([
		{ type: 'prompt', text: 'right', edited: true },
		{ type: 'text', text: 'ok' },
		{ type: 'turn-end', status: 'completed' },
	])
})

// ── Editing the last message the user sent (task dg) ──

test('an edited queued message runs as edited, in its place, and never as first written', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'tset it', queue: true, id: 'q1' })
	let queuedAt = a.views.get(id)!.inbox.find((m) => m.delivery === 'after-turn')!.ts!
	a.conn.send({ type: 'submit', sessionId: id, text: 'then ship', queue: true, id: 'q2' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'test it', amend: true, edits: 'q1', id: 'e1' })
	expect(a.of('rejected')).toEqual([])
	expect(a.of('ack').map((e) => e.id)).toEqual(['q1', 'q2', 'e1'])
	// Edited in place, not paused: the running turn never saw it.
	expect(inboxOf(a, id)).toEqual(['test it', 'then ship'])
	expect(a.views.get(id)!.state.type).toBe('running')
	restartHost()
	expect((await fresh(id)).inbox.map((m) => [m.text, m.delivery === 'after-turn'])).toEqual([
		['test it', true],
		['then ship', true],
	])
	// A resend of the edit, to the next host, is not applied again.
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	b.conn.send({ type: 'submit', sessionId: id, text: 'test it', amend: true, edits: 'q1', id: 'e1' })
	expect(b.of('ack').map((e) => e.id)).toEqual(['e1'])
	expect(inboxOf(b, id)).toEqual(['test it', 'then ship'])
	await turns.recover()
	await until(() => calls.length === 2)
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === 3)
	expect(texts(calls[2]!.input.messages.at(-1))).toEqual([
		expect.stringContaining(
			`<hal-note>Message was queued at ${queuedAt}, take that into account when reading it.</hal-note>\ntest it`,
		),
	])
	calls[2]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === 4)
	calls[3]!.push({ type: 'done', reason: 'end' })
	await until(() => b.views.get(id)!.state.type === 'idle')
	let sent = calls.flatMap((c) => c.input.messages.flatMap((m: any) => m.blocks.map((x: any) => x.text ?? '')))
	expect(sent.some((t: string) => t.includes('tset'))).toBe(false)
	expect((await fresh(id)).items.filter((i) => i.type === 'prompt').map((i: any) => i.text)).toEqual([
		'go',
		'test it',
		'then ship',
	])
})

test('a waiting message edited into a slash command runs as that command instead', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: '-help', queue: true, id: 's1' })
	a.conn.send({ type: 'submit', sessionId: id, text: '/help', amend: true, edits: 's1' })
	expect(inboxOf(a, id)).toEqual([])
	expect(a.of('command').map((e) => e.text)).toEqual(['/help'])
	expect((await fresh(id)).inbox).toEqual([])
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => a.views.get(id)!.state.type === 'idle')
	expect(calls).toHaveLength(1)
})

test('a message another session sent waits unedited', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	prompts.submit(id, 'from a peer', 'p1', 'steer', { from: 'other' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'mine now', amend: true, edits: 'p1' })
	expect(a.of('rejected')).toHaveLength(1)
	expect(a.views.get(id)!.inbox).toEqual([
		{ id: 'p1', text: 'from a peer', from: 'other', delivery: 'now', ts: expect.any(String), n: expect.any(Number) },
	])
})

test('an edit of a delivered steering message replaces it when only reading happened since', async () => {
	let a = client()
	let id = toolSession(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'look' })
	await until(() => calls.length === 1)
	calls[0]!.push(readCall())
	await until(() => a.of('stream').length)
	a.conn.send({ type: 'submit', sessionId: id, text: 'and hury' })
	calls[0]!.push({ type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	expect(inboxOf(a, id)).toEqual([])
	// Delivered: Up now pauses and edits it as the last prompt.
	await pauseAndEdit(a, id, 'and hurry')
	await until(() => calls.length === 3)
	let msgs = calls[2]!.input.messages
	expect(msgs.slice(0, -1)).toEqual(calls[1]!.input.messages.slice(0, -1))
	expect(texts(msgs.at(-1))).toEqual([stamped('and hurry')])
	calls[2]!.push({ type: 'done', reason: 'end' })
	await until(() => a.views.get(id)!.state.type === 'idle')
	expect(await fresh(id)).toEqual(a.views.get(id)!)
	expect(
		a.views
			.get(id)!
			.items.filter((i) => i.type === 'prompt')
			.map((i: any) => i.text),
	).toEqual(['look', 'and hurry'])
})

test('a resend of an edit still waiting for its paused turn to stop acks without a second prompt', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'wrnog' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'partial' })
	await until(() => a.of('stream').length)
	a.conn.send({ type: 'pause', sessionId: id })
	let edit = amending(id, 'right')
	a.conn.send({ type: 'submit', sessionId: id, text: edit, id: 'a1' })
	// A reconnect resends it before the first is carried out.
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	b.conn.send({ type: 'submit', sessionId: id, text: edit, id: 'a1' })
	await until(() => a.of('ack').length && b.of('ack').length)
	expect([...a.of('rejected'), ...b.of('rejected')]).toEqual([])
	await until(() => calls.length === 2)
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => a.views.get(id)!.state.type === 'idle')
	expect(calls).toHaveLength(2)
	expect((await records(id)).filter((r) => r.type === 'user')).toHaveLength(2)
	expect(shown(a.views.get(id)!.items.filter((i) => i.type === 'prompt'))).toEqual([
		{ type: 'prompt', text: 'right', edited: true },
	])
})
