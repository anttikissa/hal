import { expect, test } from 'bun:test'
import { replay } from './replay.ts'

test('input history includes persisted slash-command retries', () => {
	const history = replay.inputHistoryFromEntries([
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }] },
		{ type: 'input_history', text: '/config models.default [' },
	])

	expect(history).toEqual(['hello', '/config models.default ['])
})


test('input history excludes inbox-originated user entries', () => {
	const history = replay.inputHistoryFromEntries([
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }] },
		{ type: 'user', parts: [{ type: 'text', text: 'handoff from subagent' }], source: '04-7i2' },
	])

	expect(history).toEqual(['hello'])
})


test('input history preserves image placeholders in user entries', () => {
	const history = replay.inputHistoryFromEntries([
		{
			type: 'user',
			parts: [
				{ type: 'text', text: 'see ' },
				{ type: 'image', blobId: 'blob1', originalFile: '/tmp/hal/images/test.png' },
				{ type: 'text', text: ' now' },
			],
		},
	])

	expect(history).toEqual(['see [/tmp/hal/images/test.png] now'])
})


test('input history keeps image placeholders at the start', () => {
	const history = replay.inputHistoryFromEntries([
		{
			type: 'user',
			parts: [
				{ type: 'image', blobId: 'blob1', originalFile: '/tmp/hal/images/test.png' },
				{ type: 'text', text: ' explain this' },
			],
		},
	])

	expect(history).toEqual(['[/tmp/hal/images/test.png] explain this'])
})


test('input history excludes synthetic system user entries only', () => {
	const history = replay.inputHistoryFromEntries([
		{ type: 'user', parts: [{ type: 'text', text: '[system] Session was reset.' }] },
		{ type: 'user', parts: [{ type: 'text', text: '[not-system] user prompt' }] },
	])

	expect(history).toEqual(['[not-system] user prompt'])
})


test('replay preserves original image path in user text', () => {
	const result = replay.replayEntries('s1', [
		{
			type: 'user',
			parts: [
				{ type: 'text', text: 'see ' },
				{ type: 'image', blobId: 'blob1', originalFile: '/tmp/hal/images/test.png' },
				{ type: 'text', text: ' now' },
			],
		},
		{ type: 'turn_end', status: 'completed' },
	])

	expect(result.blocks).toEqual([
		{ type: 'input', text: 'see [/tmp/hal/images/test.png] now', model: undefined, source: undefined, ts: undefined },
	])
})
