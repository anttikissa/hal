import { expect, test } from 'bun:test'
import { blockData } from './block-data.ts'

test('historyToBlocks preserves original image path in user text', () => {
	const history: any[] = [
		{
			type: 'user',
			parts: [
				{ type: 'text', text: 'see ' },
				{ type: 'image', blobId: 'blob1', originalFile: '/tmp/hal/images/test.png' },
				{ type: 'text', text: ' now' },
			],
		},
	]

	const result = blockData.historyToBlocks(history as any, 's1')
	expect(result[0]).toMatchObject({ type: 'user', text: 'see [/tmp/hal/images/test.png] now' })
})


test('historyToBlocks keeps pasted text contents behind display text', () => {
	const history: any[] = [
		{
			type: 'user',
			parts: [
				{ type: 'text', text: 'Analyze this:\n\nline one\nline two', displayText: 'Analyze this:\n\n[/tmp/hal/paste/0002.txt]' },
			],
		},
	]

	const result = blockData.historyToBlocks(history as any, 's1')
	expect(result[0]).toMatchObject({
		type: 'user',
		text: 'Analyze this:\n\n[/tmp/hal/paste/0002.txt]',
		actualText: 'Analyze this:\n\nline one\nline two',
	})
})

test('historyToBlocks recovers retry state from failed turn_end', () => {
	const result = blockData.historyToBlocks([
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }] },
		{ type: 'turn_end', status: 'failed' },
	] as any, 's1')

	expect(result.at(-1)).toMatchObject({ type: 'error', text: 'Generation failed.' })
})

test('historyToBlocks recovers continue state from aborted turn_end', () => {
	const result = blockData.historyToBlocks([
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }] },
		{ type: 'turn_end', status: 'aborted' },
	] as any, 's1')

	expect(result.at(-1)).toMatchObject({ type: 'log', text: '[paused]' })
})


test('historyToBlocks hides internally-suppressed aborted turn_end', () => {
	const result = blockData.historyToBlocks([
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }] },
		{ type: 'turn_end', status: 'aborted', abortText: '' },
	] as any, 's1')

	expect(result.at(-1)).toMatchObject({ type: 'user', text: 'hello' })
})

test('historyToBlocks uses the session model for later assistant and thinking blocks', () => {
	const history: any[] = [
		{ type: 'thinking', text: 'hmm', ts: '2026-04-15T14:54:01.000Z' },
		{ type: 'assistant', text: 'done', ts: '2026-04-15T14:54:02.000Z' },
	]

	const rendered = blockData.historyToBlocks(history as any, 's1', 0, undefined, 'openai/gpt-5.4')
	expect(rendered[0]).toMatchObject({ type: 'thinking', model: 'openai/gpt-5.4', thinkingEffort: 'high' })
	expect(rendered[1]).toMatchObject({ type: 'assistant', model: 'openai/gpt-5.4' })
})


test('historyToBlocks keeps rebase lineage out of the transcript', () => {
	const result = blockData.historyToBlocks([
		{ type: 'rebased_from', log: 'history.asonl', ts: '2026-04-15T14:54:00.000Z' },
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }] },
		{ type: 'rebased_to', log: 'history3.asonl', ts: '2026-04-15T14:55:00.000Z' },
	] as any, 's1')

	expect(result).toEqual([expect.objectContaining({ type: 'user', text: 'hello' })])
})
