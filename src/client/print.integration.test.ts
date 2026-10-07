// Print-mode delivery against a real host with a controlled provider.
import { expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import { calls, client, created, until, useHost } from '../host/host-fixture.test.ts'
import { host } from '../host/host.ts'
import { print } from './print.ts'

useHost()

test('print soft-steers a busy session and returns its actual final question', async () => {
	let user = client(), id = created(user)
	user.conn.send({ type: 'submit', sessionId: id, text: 'first' })
	await until(() => calls.length === 1)
	let out: string[] = []
	let run = print.run({ prompt: 'follow up', cwd: '/tmp', session: id }, { out: (s) => out.push(s), err: () => {} })
	let conn = host.connect(run.onEvent), send = connection.send
	connection.send = (c) => conn.send(c)
	try {
		run.begin()
		await until(() => user.views.get(id)!.inbox.length === 1)
		calls[0]!.push({ type: 'text', text: 'step finished' }, { type: 'done', reason: 'end' })
		await until(() => calls.length === 2)
		expect(out).toEqual([])
		calls[1]!.push({ type: 'text', text: '<question>Which one?</question>' }, { type: 'done', reason: 'end' })
		expect(await run.done).toBe(3)
		expect(out).toEqual(['Which one?\n'])
	} finally { connection.send = send; conn.close() }
})

test('print queue waits for its own later turn, not the current final reply', async () => {
	let user = client(), id = created(user)
	user.conn.send({ type: 'submit', sessionId: id, text: 'first' })
	await until(() => calls.length === 1)
	let out: string[] = []
	let run = print.run({ prompt: 'later', cwd: '/tmp', session: id, delivery: 'queue' }, { out: (s) => out.push(s), err: () => {} })
	let conn = host.connect(run.onEvent), send = connection.send
	connection.send = (c) => conn.send(c)
	try {
		run.begin()
		await until(() => user.views.get(id)!.inbox.length === 1)
		calls[0]!.push({ type: 'text', text: 'unrelated answer' }, { type: 'done', reason: 'end' })
		await until(() => calls.length === 2)
		expect(out).toEqual([])
		calls[1]!.push({ type: 'text', text: 'own answer' }, { type: 'done', reason: 'end' })
		expect(await run.done).toBe(0)
		expect(out).toEqual(['own answer\n'])
	} finally { connection.send = send; conn.close() }
})

test('print new tab autocloses after its first prompt, while --keep stays open', async () => {
	let user = client()
	user.conn.send({ type: 'tab-new', cwd: '/tmp' })
	for (let keep of [undefined, true] as const) {
		let run = print.run({ prompt: 'task', cwd: '/tmp', ...(keep && { keep }) }, { out: () => {}, err: () => {} })
		let conn = host.connect(run.onEvent), send = connection.send
		let before = calls.length
		connection.send = (c) => conn.send(c)
		try {
			run.begin()
			await until(() => calls.length === before + 1)
			let tab = user.of('tabs').at(-1)!.tabs.at(-1)!.id
			calls[before]!.push({ type: 'text', text: 'done' }, { type: 'done', reason: 'end' })
			expect(await run.done).toBe(0)
			expect(user.of('tabs').at(-1)!.tabs.some((t: { id: string }) => t.id === tab)).toBe(!!keep)
		} finally { connection.send = send; conn.close() }
	}
})
