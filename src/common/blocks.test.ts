import { expect, test } from 'bun:test'
import { blocks, type StreamEvent } from './blocks.ts'

function run(events: StreamEvent[], provider = 'anthropic') {
	return blocks.collect(events, provider)
}

test('consecutive deltas merge; a kind change starts a new block', () => {
	let turn = run([
		{ type: 'thinking', text: 'Let me ' },
		{ type: 'thinking', text: 'think.' },
		{ type: 'signature', value: 'sig-1' },
		{ type: 'text', text: 'Hello ' },
		{ type: 'text', text: 'world' },
		{ type: 'tool_call', id: 't1', name: 'read', input: { path: 'a' } },
		{ type: 'text', text: 'after' },
		{ type: 'done', reason: 'tool_use' },
	])
	expect(turn.blocks).toEqual([
		{ type: 'thinking', text: 'Let me think.', signature: 'sig-1', provider: 'anthropic' },
		{ type: 'text', text: 'Hello world' },
		{ type: 'tool_call', id: 't1', name: 'read', input: { path: 'a' } },
		{ type: 'text', text: 'after' },
	])
	expect(turn.end).toEqual({ type: 'done', reason: 'tool_use' })
})

test('a signature closes its thinking block', () => {
	let turn = run([
		{ type: 'thinking', text: 'one' },
		{ type: 'signature', value: 's1' },
		{ type: 'thinking', text: 'two' },
		{ type: 'signature', value: 's2' },
	])
	expect(turn.blocks.map((b) => b.type === 'thinking' && [b.text, b.signature])).toEqual([
		['one', 's1'],
		['two', 's2'],
	])
})

test('a signature with no thinking text still makes a thinking block', () => {
	let turn = run([{ type: 'text', text: 'hi' }, { type: 'signature', value: 'enc' }], 'openai')
	expect(turn.blocks).toEqual([
		{ type: 'text', text: 'hi' },
		{ type: 'thinking', text: '', signature: 'enc', provider: 'openai' },
	])
})

test('usage fields are cumulative: later events overwrite what they carry', () => {
	let turn = run([
		{ type: 'usage', usage: { input: 10, cacheRead: 90, output: 1 } },
		{ type: 'usage', usage: { output: 42 } },
		{ type: 'done', reason: 'end' },
	])
	expect(turn.usage).toEqual({ input: 10, cacheRead: 90, output: 42 })
})

test('an error ends the turn but keeps the partial blocks', () => {
	let turn = run([{ type: 'text', text: 'part' }, { type: 'error', message: 'overloaded', status: 529 }])
	expect(turn.blocks).toEqual([{ type: 'text', text: 'part' }])
	expect(turn.end).toEqual({ type: 'error', message: 'overloaded', status: 529 })
})

test('a stream without a terminal event leaves the turn open', () => {
	expect(run([{ type: 'text', text: 'a' }]).end).toBeUndefined()
})

test('parseModelId splits on the first slash only', () => {
	expect(blocks.parseModelId('anthropic/claude-sonnet-4-5')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' })
	expect(blocks.parseModelId('openrouter/anthropic/claude-4.5')).toEqual({ provider: 'openrouter', model: 'anthropic/claude-4.5' })
	for (let bad of ['claude', '/model', 'anthropic/', '']) expect(blocks.parseModelId(bad)).toBeUndefined()
})
