import { expect, test } from 'bun:test'
import type { AssistantBlock, UserBlock } from './blocks.ts'
import { replay, type HistoryRecord, type TurnStatus } from './replay.ts'

const ts = '2026-01-01T00:00:00.000Z'
const user = (...blocks: UserBlock[]): HistoryRecord => ({ type: 'user', blocks, ts })
const say = (text: string): HistoryRecord => user({ type: 'text', text })
const block = (b: AssistantBlock): HistoryRecord => ({ type: 'assistant', block: b, ts })
const end = (status: TurnStatus): HistoryRecord => ({ type: 'turn_end', status, usage: {}, ts })
const call = (id: string): AssistantBlock => ({ type: 'tool_call', id, name: 'bash', input: { cmd: 'ls' } })

test('prompts and assistant blocks become alternating messages', () => {
	let msgs = replay.toMessages([
		say('hi'),
		block({ type: 'thinking', text: 'hmm', signature: 'sig', provider: 'anthropic' }),
		block({ type: 'text', text: 'hello' }),
		end('completed'),
		say('again'),
		block({ type: 'text', text: 'yes' }),
		end('completed'),
	])
	expect(msgs).toEqual([
		{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
		{
			role: 'assistant',
			blocks: [
				{ type: 'thinking', text: 'hmm', signature: 'sig', provider: 'anthropic' },
				{ type: 'text', text: 'hello' },
			],
		},
		{ role: 'user', blocks: [{ type: 'text', text: 'again' }] },
		{ role: 'assistant', blocks: [{ type: 'text', text: 'yes' }] },
	])
})

test('a turn that produced nothing leaves no empty message; prompts merge', () => {
	let msgs = replay.toMessages([say('one'), end('error'), say('two'), end('cancelled'), say('three')])
	expect(msgs).toEqual([
		{
			role: 'user',
			blocks: [
				{ type: 'text', text: 'one' },
				{ type: 'text', text: 'two' },
				{ type: 'text', text: 'three' },
			],
		},
	])
})

test('partial text of a cancelled turn is kept; unsigned thinking is not replayed', () => {
	let msgs = replay.toMessages([
		say('hi'),
		block({ type: 'thinking', text: 'half a thou' }),
		end('cancelled'),
		say('go on'),
		block({ type: 'thinking', text: 'x' }),
		block({ type: 'text', text: 'partial ans' }),
		end('cancelled'),
	])
	expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
	expect(msgs[1]!.blocks).toEqual([{ type: 'text', text: 'partial ans' }])
})

test('tool calls get their results; unanswered ones get an error result before the next prompt', () => {
	let msgs = replay.toMessages([
		say('run'),
		block(call('a')),
		block(call('b')),
		end('completed'),
		user({ type: 'tool_result', id: 'a', output: 'ok' }),
		block(call('c')),
		end('cancelled'),
		say('never mind'),
	])
	expect(msgs).toHaveLength(5)
	let [, , results1, , next] = msgs
	expect(results1!.role).toBe('user')
	let ids1 = results1!.blocks.map((b) => b.type === 'tool_result' && b.id)
	expect(ids1.sort()).toEqual(['a', 'b'])
	expect(results1!.blocks.find((b) => b.type === 'tool_result' && b.id === 'a')).toMatchObject({ output: 'ok' })
	expect(results1!.blocks.find((b) => b.type === 'tool_result' && b.id === 'b')).toMatchObject({ isError: true })
	// Results come first, then the prompt.
	expect(next!.blocks[0]).toMatchObject({ type: 'tool_result', id: 'c', isError: true })
	expect(next!.blocks[1]).toEqual({ type: 'text', text: 'never mind' })
})

test('tool results without a matching call are dropped', () => {
	let msgs = replay.toMessages([say('x'), end('interrupted'), user({ type: 'tool_result', id: 'ghost', output: '' }), say('y')])
	expect(msgs).toEqual([
		{
			role: 'user',
			blocks: [
				{ type: 'text', text: 'x' },
				{ type: 'text', text: 'y' },
			],
		},
	])
})

test('openTurn: records after the last turn end mean a turn is still open', () => {
	expect(replay.openTurn([])).toBe(false)
	expect(replay.openTurn([say('a'), end('completed')])).toBe(false)
	expect(replay.openTurn([say('a')])).toBe(true)
	expect(replay.openTurn([say('a'), end('completed'), say('b'), block({ type: 'text', text: 'x' })])).toBe(true)
})
