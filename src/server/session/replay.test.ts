import { expect, test } from 'bun:test'
import { STATE_DIR } from '../state.ts'
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


test('compaction context preserves first pair and recent user-assistant context', () => {
	const context = replay.buildCompactionContext('s1', [
		{ type: 'user', parts: [{ type: 'text', text: 'first prompt\nwith detail' }] },
		{ type: 'assistant', text: 'first answer' },
		{ type: 'tool_call', toolId: 't1', name: 'read' },
		{ type: 'thinking', text: 'hidden thoughts' },
		{ type: 'assistant', text: 'old assistant' },
		{ type: 'user', parts: [{ type: 'text', text: 'old prompt' }] },
		{ type: 'assistant', text: 'old answer' },
		{ type: 'user', parts: [{ type: 'text', text: 'recent one' }] },
		{ type: 'tool_call', toolId: 't2', name: 'bash' },
		{ type: 'assistant', text: 'answer after recent one' },
		{ type: 'user', parts: [{ type: 'text', text: 'recent two' }] },
		{ type: 'thinking', text: 'more hidden thoughts' },
		{ type: 'assistant', text: 'answer after recent two' },
		{ type: 'user', parts: [{ type: 'text', text: 'recent three' }] },
		{ type: 'assistant', text: 'final answer' },
	])

	expect(context).toBe([
		'Context was compacted to avoid exceeding the token limit. Verify before assuming.',
		'',
		"Here's summary of what happened (only user and assistant messages preserved):",
		'',
		'[1] user: first prompt\nwith detail',
		'[2] assistant: first answer',
		'[3-7] 1 tool call, 1 thinking block, 2 assistant blocks, 1 prompt omitted',
		'[8] user: recent one',
		'[9] 1 tool call omitted',
		'[10] assistant: answer after recent one',
		'[11] user: recent two',
		'[12] 1 thinking block omitted',
		'[13] assistant: answer after recent two',
		'[14] user: recent three',
		'[15] assistant: final answer',
		'',
		`Full history: ${STATE_DIR}/sessions/s1/history*.asonl + blobs/`,
	].join('\n'))
})


test('compaction context trims huge assistant blocks from the middle', () => {
	const longAssistant = `${'A'.repeat(1100)}${'M'.repeat(3000)}${'Z'.repeat(2200)}`
	const context = replay.buildCompactionContext('s1', [
		{ type: 'user', parts: [{ type: 'text', text: 'prompt' }] },
		{ type: 'assistant', text: longAssistant },
	])

	expect(context).toContain(`[2] assistant: ${'A'.repeat(1024)}`)
	expect(context).toContain('[...block of size 6kB trimmed down to 3kB...]')
	expect(context).toContain('Z'.repeat(2048))
	expect(context).not.toContain('M'.repeat(100))
	expect(Buffer.byteLength(context, 'utf8')).toBeLessThan(Buffer.byteLength(longAssistant, 'utf8'))
})
