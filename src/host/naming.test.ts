import { expect, test } from 'bun:test'
import { client, calls, created, restartHost, until, useHost } from './host-fixture.test.ts'
import { sessions } from './sessions.ts'
import { naming } from './naming.ts'
import { history } from './history.ts'
import { names } from '../common/names.ts'

useHost(true)

test('model command supplies the first title, can replace a human title, and reminders survive restart', async () => {
	let c = client(), id = created(c)
	naming.manual(id)
	for (let turn = 1; turn <= 8; turn++) {
		let at = calls.length
		c.conn.send({ type: 'submit', sessionId: id, text: `Repair replay turn ${turn}` })
		await until(() => calls.length > at)
		let input = JSON.stringify(calls[at]!.input.messages.at(-1))
		expect(input.includes('use the command tool')).toBe([1, 2, 3, 7].includes(turn))
		if (turn === 1) expect(sessions.open(id).name).toBe(names.fallback(id))
		if (turn === 4) {
			naming.manual(id, 'Human title')
			// Naming is an ordinary command even on a non-reminder turn.
			calls[at]!.push({ type: 'tool_call', id: 'rename-4', name: 'command', input: { command: '/rename Repair durable provider replay' } }, { type: 'done', reason: 'tool_use' })
			await until(() => calls.length > at + 1)
			expect(sessions.open(id).name).toBe('Repair durable provider replay')
			calls[at + 1]!.push({ type: 'text', text: 'Done.' }, { type: 'done', reason: 'end' })
		} else if (turn === 1) {
			calls[at]!.push({ type: 'tool_call', id: 'rename-1', name: 'command', input: { command: '/rename Fix provider replay persistence' } }, { type: 'done', reason: 'tool_use' })
			await until(() => calls.length > at + 1)
			expect(sessions.open(id).name).toBe('Fix provider replay persistence')
			calls[at + 1]!.push({ type: 'text', text: 'Done.' }, { type: 'done', reason: 'end' })
		} else {
			if (turn === 5) expect(input).toContain('Repair durable provider replay')
			calls[at]!.push({ type: 'text', text: 'Done.\n<rename>Legacy control must not act</rename>' }, { type: 'done', reason: 'end' })
		}
		await until(() => !history.state.running.has(id))
		if (turn === 3) { restartHost(); c = client(); c.conn.send({ type: 'open', sessionId: id }); await until(() => c.views.has(id)) }
	}
	expect(sessions.open(id).name).toBe('Repair durable provider replay')
	let records = history.readSync(id)
	expect(records.filter((r) => r.type === 'command').map((r) => r.text)).toContain('/rename Repair durable provider replay')
	expect(records.some((r) => r.type === 'output' && r.text.includes('Human title → Repair durable provider replay'))).toBe(true)
	expect(records.some((r) => r.type === 'assistant' && r.block.type === 'text' && r.block.text.includes('<rename>'))).toBe(true)
})

test('absent model rename keeps placeholder and legacy backfill never copies a prompt', async () => {
	let c = client(), id = created(c)
	naming.manual(id)
	c.conn.send({ type: 'submit', sessionId: id, text: 'A long first request that must never become a session title' })
	await until(() => calls.length > 0)
	calls[0]!.push({ type: 'text', text: 'Done.' }, { type: 'done', reason: 'end' })
	await until(() => !history.state.running.has(id))
	c.conn.send({ type: 'submit', sessionId: id, text: '/rename backfill' })
	await until(() => c.of('output').some((e) => e.text.includes('backfill')))
	expect(sessions.open(id).name).toBe(names.fallback(id))
	restartHost()
	expect(sessions.open(id).name).toBe(names.fallback(id))
})
