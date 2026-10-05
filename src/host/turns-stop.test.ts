// A turn stops when it should (turns.ts): the round cap, stop reasons
// that run no tools, and Escape killing a running command.

import { afterEach, expect, test } from 'bun:test'
import { settings } from '../common/settings.ts'
import { calls, client, readCall, records, toolSession, until, useHost } from './host-fixture.test.ts'
import { tools } from './tools.ts'

useHost()

afterEach(() => {
	settings.state.raw = {}
})

test('a model that never stops asking for tools pauses at maxRounds; continue gives as many again', async () => {
	settings.state.raw = { maxRounds: 3 }
	let a = client()
	let id = toolSession(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'loop' })
	let answer = async (n: number) => {
		for (let i = calls.length; i < n; i++) {
			await until(() => calls.length === i + 1)
			calls[i]!.push(readCall(`t${i}`), { type: 'done', reason: 'tool_use' })
		}
	}
	await answer(3)
	await until(() => a.of('turn-end').length === 1)
	expect(calls.length).toBe(3)
	expect(a.of('turn-end')[0].status).toBe('paused')
	let state = a.views.get(id)!.state
	expect(state.type).toBe('paused')
	expect((state as any).reason).toContain('3')
	// Every round's tools ran, the last one's too.
	expect((await records(id)).filter((r) => r.type === 'user').length).toBe(4)

	a.conn.send({ type: 'continue', sessionId: id })
	await answer(6)
	await until(() => a.of('turn-end').length === 2)
	expect(calls.length).toBe(6)
	expect(a.of('turn-end')[1].status).toBe('paused')
})

test('a round cut off at max_tokens or refused runs none of its tool calls and ends in error', async () => {
	let ran = 0
	let origRun = tools.run
	tools.run = async (call, ctx) => (ran++, origRun(call, ctx))
	try {
		for (let [done, error] of [
			[{ type: 'done', reason: 'max_tokens' }, 'max_tokens'],
			[{ type: 'done', reason: 'refusal', explanation: 'Not allowed here.' }, 'Not allowed here.'],
		] as const) {
			let a = client()
			let id = toolSession(a)
			let before = calls.length
			a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
			await until(() => calls.length === before + 1)
			calls[before]!.push(readCall(), done)
			await until(() => a.of('turn-end').length)
			let end = a.of('turn-end')[0]
			expect(end.status).toBe('error')
			expect(end.error).toContain(error)
			expect(calls.length).toBe(before + 1)
			expect(a.views.get(id)!.items.some((i) => i.type === 'tool-result')).toBe(false)
		}
		expect(ran).toBe(0)
	} finally {
		tools.run = origRun
	}
})
