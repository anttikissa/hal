// Provider input rebuilt from history (history-input.ts): messages and
// single-round turns.
import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import type { Message } from '../common/blocks.ts'
import { history } from './history.ts'
import { historyInput } from './history-input.ts'
import { anthropic } from './anthropic.ts'
import { sessions } from './sessions.ts'
import { busy } from './busy.ts'
import { drain, fakeStream, newSession, useHistory } from './history-fixture.test.ts'

useHistory()

test('a prompt after a failed turn is its own message, told of the failure', async () => {
	let id = newSession()
	let sent = fakeStream((input) =>
		input.messages.length === 1
			? [{ type: 'error', message: 'HTTP 400 from fake', status: 400 }]
			: [{ type: 'done', reason: 'end' }],
	)
	history.submit(id, 'Say just the word pong')
	await drain(historyInput.turn(id))
	history.submit(id, 'k')
	await drain(historyInput.turn(id))
	expect(sent[1]).toEqual([
		{
			role: 'user',
			blocks: [{ type: 'text', text: expect.stringMatching(/^\[[\d -]+:\d\d[^\]\n]*\]\nSay just the word pong$/) }],
		},
		{
			role: 'user',
			blocks: [{ type: 'text', text: expect.stringContaining('The turn failed with an error: HTTP 400 from fake') }],
		},
		{ role: 'user', blocks: [{ type: 'text', text: expect.stringMatching(/^\[[\d -]+:\d\d[^\]\n]*\]\nk$/) }] },
	])
})

test('thinking signatures live in blobs and replay exactly, rebuilt from disk alone', async () => {
	let id = newSession()
	let signature = `{"type":"reasoning","id":"rs_1","encrypted_content":"gAAA\\u0000'\`\${x}"}\n\t\\ ä😀 ${'z'.repeat(5000)}`
	let sent = fakeStream((input) =>
		input.messages.length === 1
			? [
					{ type: 'thinking', text: 'why' },
					{ type: 'signature', value: signature },
					{ type: 'text', text: 'ok' },
					{ type: 'done', reason: 'end' },
				]
			: [{ type: 'done', reason: 'end' }],
	)
	history.submit(id, 'q1')
	await drain(historyInput.turn(id))
	// Every record is one line, and the signature is not among them.
	let lines = readFileSync(history.file(id), 'utf8').trimEnd().split('\n')
	expect(lines).toHaveLength(4)
	expect(lines.join('\n')).not.toContain('zzzz')
	sessions.closeAll()
	await history.open(id)
	history.submit(id, 'q2')
	await drain(historyInput.turn(id))
	expect(sent[1]![1]).toEqual({
		role: 'assistant',
		blocks: [
			{ type: 'thinking', text: 'why', signature, provider: 'fake' },
			{ type: 'text', text: 'ok' },
		],
	})
})

test('a failed turn stores the provider body with the message, never just a headline', async () => {
	let id = newSession()
	fakeStream(() => [{ type: 'error', message: 'Invalid JSON input', body: '{"command": "ls' }])
	history.submit(id, 'go')
	await drain(historyInput.turn(id))
	expect((await history.read(id)).at(-1)).toMatchObject({
		type: 'turn_end',
		status: 'error',
		error: 'Invalid JSON input\n{"command": "ls',
	})
})

test('a host notice reaches the next request once and never starts a turn', async () => {
	let id = newSession()
	history.append(id, { type: 'notice', text: 'Hal restarted.' })
	expect(busy.list()).not.toContain(id)
	let first = JSON.stringify(await historyInput.messages(id))
	expect(first).toContain('Hal restarted.')
	expect(busy.list()).not.toContain(id)
	expect(JSON.stringify(await historyInput.messages(id))).toBe(first)
})

test('returning to a model marks its last input end beyond the lookback', async () => {
	let id = newSession()
	let opus = 'anthropic/claude-opus-5-5'
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'first question' }] })
	let answer = history.append(id, { type: 'assistant', block: { type: 'text', text: 'answer' } })
	history.append(id, { type: 'round', usage: { input: 1 }, model: opus, block: answer.n })
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'ask another model' }] })
	for (let i = 0; i < 15; i++) {
		history.append(id, {
			type: 'assistant',
			block: { type: 'tool_call', id: `c${i}`, name: 'bash', input: { command: 'ls' } },
		})
		history.append(id, { type: 'user', blocks: [{ type: 'tool_result', id: `c${i}`, output: 'x' }] })
		history.append(id, { type: 'round', usage: { input: 1 }, model: 'openai/gpt-6-astra' })
	}
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'back' }] })
	let marked = (messages: Message[]) =>
		anthropic
			.toMessages({ model: 'claude-opus-5-5', messages })
			.flatMap((m) => m.content)
			.filter((b: any) => b.cache_control)
			.map((b: any) => b.text ?? b.type)
	expect(marked(await historyInput.messages(id, { model: opus }))).toEqual([
		expect.stringContaining('first question'),
		expect.stringContaining('back'),
	])
	// Once this model has the latest round, the newest marker reaches it.
	history.append(id, { type: 'round', usage: { input: 1 }, model: opus })
	expect(marked(await historyInput.messages(id, { model: opus }))).toEqual([expect.stringContaining('back')])
})
