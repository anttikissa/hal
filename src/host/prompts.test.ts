// What the user sends (prompts.ts): steering and queued messages in the
// inbox. Edits are in prompts-edit.test.ts.

import { expect, test } from 'bun:test'
import { titles } from '../common/titles.ts'
import {
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
import { turns } from './turns.ts'

useHost()

for (let [input, output] of [
	['/ hello', 'hello'],
	['/ /hello world', '/hello world'],
	['/  /hello', ' /hello'],
	['/ / /hello', '/ /hello'],
	[' /hello world', ' /hello world'],
]) {
	test(`literal slash prompt: ${JSON.stringify(input)}`, async () => {
		let a = client()
		let id = created(a)
		a.conn.send({ type: 'submit', sessionId: id, text: input! })
		await until(() => calls.length === 1)
		expect(texts(calls[0]!.input.messages.at(-1))).toEqual([stamped(output!)])
		expect(a.of('rejected')).toEqual([])
	})
}

test('ordinary messages abort the round and coalesce before its replacement request', async () => {
	let a = client()
	let id = created(a)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'work' })
	await until(() => a.of('stream').length)
	b.conn.send({ type: 'submit', sessionId: id, text: 'one' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'two', id: 'x2' })
	expect([...a.of('rejected'), ...b.of('rejected')]).toEqual([])
	expect(a.of('ack').map((e) => e.id)).toEqual(['x2'])
	// Visible to everyone immediately; no provider completion is needed.
	expect(inboxOf(a, id)).toEqual(['one', 'two'])
	expect(inboxOf(b, id)).toEqual(['one', 'two'])
	expect((await fresh(id)).inbox.map((m) => m.text)).toEqual(['one', 'two'])
	expect(calls.length).toBe(1)
	await until(() => calls.length === 2)
	expect(a.of('turn-end')).toEqual([])
	// The earlier request is a prefix of this one: the prompt cache stays warm.
	let first = calls[0]!.input.messages
	expect(calls[1]!.input.messages.slice(0, first.length)).toEqual(first)
	expect(calls[1]!.input.messages.slice(first.length)).toEqual([
		{ role: 'assistant', blocks: [{ type: 'text', text: 'work' }] },
		{ role: 'user', blocks: [{ type: 'text', text: stamped('one\n\ntwo') }] },
	])
	expect(inboxOf(a, id)).toEqual([])
	expect(
		a.views
			.get(id)!
			.items.filter((i) => i.type === 'prompt')
			.map(titles.who),
	).toEqual(['You', 'You (steering)', 'You (steering)'])
	// Again, and again the prefix holds.
	calls[1]!.push({ type: 'text', text: 'ok' })
	await until(() => a.views.get(id)!.items.at(-1)?.type === 'text')
	a.conn.send({ type: 'submit', sessionId: id, text: 'three' })
	await until(() => calls.length === 3)
	let second = calls[1]!.input.messages
	expect(calls[2]!.input.messages.slice(0, second.length)).toEqual(second)
	expect(texts(calls[2]!.input.messages.at(-1))).toEqual([stamped('three')])
	calls[2]!.push({ type: 'text', text: 'done' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length && b.of('turn-end').length)
	let view = await fresh(id)
	expect(shown(view.items)).toEqual([
		{ type: 'prompt', text: 'go', interactive: true },
		{ type: 'text', text: 'work', interrupted: true },
		{ type: 'prompt', text: 'one', delivery: 'now', interactive: true },
		{ type: 'prompt', text: 'two', delivery: 'now', interactive: true },
		{ type: 'text', text: 'ok', interrupted: true },
		{ type: 'prompt', text: 'three', delivery: 'now', interactive: true },
		{ type: 'text', text: 'done' },
		{ type: 'turn-end', status: 'completed' },
	])
	expect(view.items.filter((i) => i.type === 'prompt').map(titles.who)).toEqual([
		'You',
		'You (steering)',
		'You (steering)',
		'You (steering)',
	])
	expect(a.views.get(id)).toEqual(view)
	expect(b.views.get(id)).toEqual(view)
	expect(a.of('turn-end')).toHaveLength(1)
})

test('steering before tool dispatch suppresses its call and pairs replay results', async () => {
	let a = client()
	let id = toolSession(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'look' })
	await until(() => calls.length === 1)
	calls[0]!.push(readCall())
	await until(() => a.of('stream').length)
	a.conn.send({ type: 'submit', sessionId: id, text: 'and hurry' })
	calls[0]!.push({ type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages.slice(-2)).toEqual([
		{
			role: 'user',
			blocks: [
				{ type: 'tool_result', id: 't1', output: expect.stringContaining('did not run'), interrupted: 'canceled' },
			],
		},
		{ role: 'user', blocks: [{ type: 'text', text: stamped('and hurry') }] },
	])
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length)
	expect(await fresh(id)).toEqual(a.views.get(id)!)
})

test('a queued message waits for the turn to end, then runs as the next turn', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'later', queue: true })
	let queuedAt = a.views.get(id)!.inbox.find((m) => m.delivery === 'after-turn')!.ts!
	a.conn.send({ type: 'submit', sessionId: id, text: 'now' })
	expect(a.views.get(id)!.inbox).toEqual([
		{
			id: expect.any(String),
			text: 'now',
			delivery: 'now',
			ts: expect.any(String),
			n: expect.any(Number),
			interactive: true,
		},
		{
			id: expect.any(String),
			text: 'later',
			delivery: 'after-turn',
			ts: expect.any(String),
			n: expect.any(Number),
			interactive: true,
		},
	])
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === 2)
	expect(texts(calls[1]!.input.messages.at(-1))).toEqual([stamped('now')])
	expect(inboxOf(a, id)).toEqual(['later'])
	calls[1]!.push({ type: 'text', text: 'first done' }, { type: 'done', reason: 'end' })
	await until(() => calls.length === 3)
	expect(a.of('turn-end')).toHaveLength(1)
	expect(texts(calls[2]!.input.messages.at(-1))).toEqual([
		expect.stringContaining(
			`<hal-note>Message was queued at ${queuedAt}, take that into account when reading it.</hal-note>\nlater`,
		),
	])
	expect(inboxOf(a, id)).toEqual([])
	let delivered = a.views.get(id)!.items.find((i) => i.type === 'prompt' && i.text === 'later')!
	expect(delivered).toMatchObject({ delivery: 'after-turn', queuedAt })
	expect(titles.title(delivered)).toBe(`${titles.time(delivered.ts)} You (queued at ${titles.time(queuedAt)})`)
	calls[2]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 2)
	let view = await fresh(id)
	expect(view.items.map((i) => i.type)).toEqual(['prompt', 'prompt', 'text', 'turn-end', 'prompt', 'turn-end'])
	expect(a.views.get(id)).toEqual(view)
	expect(view.items.find((i) => i.type === 'prompt' && i.text === 'later')).toMatchObject({
		delivery: 'after-turn',
		queuedAt,
	})
})

// Task nd6: a turn that ends with <question> waits for the user; queued
// messages run only after a later final answer.
test('queued messages wait through an asking turn until the reply turn ends', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'later', queue: true })
	calls[0]!.push({ type: 'text', text: 'Which one?\n<question>A or B?</question>' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'also', queue: true })
	await Bun.sleep(50)
	expect(calls).toHaveLength(1)
	expect(inboxOf(a, id)).toEqual(['later', 'also'])
	a.conn.send({ type: 'submit', sessionId: id, text: 'A' })
	await until(() => calls.length === 2)
	expect(texts(calls[1]!.input.messages.at(-1))).toEqual([stamped('A')])
	calls[1]!.push({ type: 'text', text: 'Done.\n<summary>Did A.</summary>' }, { type: 'done', reason: 'end' })
	await until(() => calls.length === 3)
	expect(texts(calls[2]!.input.messages.at(-1))).toEqual([expect.stringContaining('later')])
})

test('a queued message sent to an idle session just runs', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi', queue: true })
	await until(() => calls.length === 1)
	expect(inboxOf(a, id)).toEqual([])
})

test('a next-round message leaves the stream running and arrives after the answer', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'work' })
	await until(() => a.of('stream').length)
	a.conn.send({ type: 'submit', sessionId: id, text: 'later', delivery: 'soft-steer' })
	await until(() => inboxOf(a, id).length === 1)
	calls[0]!.push({ type: 'text', text: ' done' })
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages.slice(-2)).toEqual([
		{ role: 'assistant', blocks: [{ type: 'text', text: 'work done' }] },
		{ role: 'user', blocks: [{ type: 'text', text: stamped('later') }] },
	])
})

test('an empty Enter sends the next queued message early, undo queues it again, Ctrl-Enter interrupts with it', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'work' })
	await until(() => a.of('stream').length)
	a.conn.send({ type: 'submit', sessionId: id, text: 'later', delivery: 'queue' })
	let queued = () => a.views.get(id)!.inbox.filter((m) => m.delivery === 'after-turn').length
	await until(() => queued() === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: '/queue next' })
	await until(() => queued() === 0)
	expect(a.views.get(id)!.inbox).toMatchObject([
		{ text: 'later', delivery: 'next-round', queuedAt: expect.any(String) },
	])
	a.conn.send({ type: 'submit', sessionId: id, text: '/queue undo' })
	await until(() => queued() === 1)
	expect(calls.length).toBe(1)
	a.conn.send({ type: 'submit', sessionId: id, text: '/queue now' })
	await until(() => calls.length === 2)
	expect(texts(calls[1]!.input.messages.at(-1))).toEqual([
		expect.stringMatching(/queued at [^\n]*\n<hal-note>Message was queued at [^<]+<\/hal-note>\nlater$/),
	])
})

test('the inbox survives a pause and a restart, and runs when the user continues', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'part' })
	await until(() => a.of('stream').length)
	a.conn.send({ type: 'submit', sessionId: id, text: 'steer' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'queued', queue: true })
	let queuedAt = a.views.get(id)!.inbox.find((m) => m.delivery === 'after-turn')!.ts!
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.of('turn-end').length)
	expect(calls.length).toBe(1)
	restartHost()
	await turns.recover()
	expect(calls.length).toBe(1)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	expect(b.views.get(id)!.state).toEqual({ type: 'paused' })
	expect(inboxOf(b, id)).toEqual(['steer', 'queued'])
	b.conn.send({ type: 'continue', sessionId: id })
	await until(() => calls.length === 2)
	expect(texts(calls[1]!.input.messages.at(-1))).toEqual([stamped('steer')])
	expect(inboxOf(b, id)).toEqual(['queued'])
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === 3)
	expect(texts(calls[2]!.input.messages.at(-1))).toEqual([
		expect.stringContaining(
			`<hal-note>Message was queued at ${queuedAt}, take that into account when reading it.</hal-note>\nqueued`,
		),
	])
	calls[2]!.push({ type: 'done', reason: 'end' })
	await until(() => b.of('turn-end').length === 2)
	expect(await fresh(id)).toEqual(b.views.get(id)!)
})

test('a queued message left behind by a host dying after a turn end runs on the next host', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'later', queue: true })
	let queuedAt = a.views.get(id)!.inbox.find((m) => m.delivery === 'after-turn')!.ts!
	// The host dies after writing the turn end, before the queued prompt.
	let next = prompts.next
	prompts.next = () => {}
	try {
		calls[0]!.push({ type: 'done', reason: 'end' })
		await until(() => a.of('turn-end').length)
	} finally {
		prompts.next = next
	}
	restartHost()
	await turns.recover()
	await until(() => calls.length === 2)
	expect(texts(calls[1]!.input.messages.at(-1))).toEqual([
		expect.stringContaining(
			`<hal-note>Message was queued at ${queuedAt}, take that into account when reading it.</hal-note>\nlater`,
		),
	])
	calls[1]!.push({ type: 'done', reason: 'end' })
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id)?.state.type === 'idle')
	expect(inboxOf(b, id)).toEqual([])
	await turns.recover()
	expect(calls.length).toBe(2)
})

test('sending to a paused turn takes the waiting messages along, oldest first', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'first' })
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.of('turn-end').length)
	a.conn.send({ type: 'submit', sessionId: id, text: 'second' })
	await until(() => calls.length === 2)
	expect(texts(calls[1]!.input.messages.at(-1))).toEqual([stamped('first\n\nsecond')])
	expect(JSON.stringify(calls[1]!.input.messages.at(-2))).toContain('The user paused the turn.')
	expect(inboxOf(a, id)).toEqual([])
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 2)
	let view = await fresh(id)
	expect(shown(view.items.filter((i) => i.type === 'prompt'))).toEqual([
		{ type: 'prompt', text: 'go', interactive: true },
		{ type: 'prompt', text: 'first', delivery: 'now', interactive: true },
		{ type: 'prompt', text: 'second', interactive: true },
	])
	expect(view.items.filter((i) => i.type === 'prompt').map(titles.who)).toEqual(['You', 'You (steering)', 'You'])
	expect(a.views.get(id)).toEqual(view)
})

test('a steer resent to the next host is not added twice', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'more', id: 'm1' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'more', id: 'm1' })
	expect(inboxOf(a, id)).toEqual(['more'])
	restartHost()
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	b.conn.send({ type: 'submit', sessionId: id, text: 'more', id: 'm1' })
	expect(b.of('ack').map((e) => e.id)).toEqual(['m1'])
	let pending = inboxOf(b, id).filter((text) => text === 'more').length
	let delivered = (await records(id)).filter(
		(r) => r.type === 'user' && r.blocks.some((b) => b.type === 'text' && b.text === 'more'),
	).length
	expect(pending + delivered).toBe(1)
})

test('agent reports retain next-round delivery through a question and restart, arriving with the human answer', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push(
		{ type: 'text', text: 'Recommendation.\n<question>A or B?</question>' },
		{ type: 'done', reason: 'end' },
	)
	await until(() => a.of('turn-end').length === 1)
	prompts.submit(id, 'agent report', undefined, 'steer', { from: 'other', advisory: true })
	prompts.submit(id, 'agent steer', undefined, 'soft-steer', { from: 'other' })
	prompts.submit(id, 'explicit queue', undefined, 'queue', { from: 'other' })
	expect(inboxOf(a, id)).toEqual(['agent report', 'agent steer', 'explicit queue'])
	expect(a.views.get(id)!.inbox.map((m) => m.delivery)).toEqual(['next-round', 'next-round', 'after-turn'])
	restartHost()
	expect((await fresh(id)).inbox.map((m) => [m.text, m.delivery])).toEqual([
		['agent report', 'next-round'],
		['agent steer', 'next-round'],
		['explicit queue', 'after-turn'],
	])
	expect(calls).toHaveLength(1)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	b.conn.send({ type: 'submit', sessionId: id, text: 'A' })
	await until(() => calls.length === 2)
	let delivered = texts(calls[1]!.input.messages.at(-1)).join('\n')
	expect(delivered).toContain('agent report')
	expect(delivered).toContain('agent steer')
	expect(delivered).toMatch(/\nA$/)
	expect(delivered).not.toContain('explicit queue')
	expect(b.views.get(id)!.inbox.map((m) => m.text)).toEqual(['explicit queue'])
	calls[1]!.push({ type: 'text', text: '<summary>Did A.</summary>' }, { type: 'done', reason: 'end' })
	await until(() => calls.length === 3)
	expect(texts(calls[2]!.input.messages.at(-1)).join('\n')).toContain('explicit queue')
	expect(b.views.get(id)!.inbox).toEqual([])
})
