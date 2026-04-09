import { expect, test } from 'bun:test'
import type { Message } from '../protocol.ts'
import { apiMessages } from './api-messages.ts'

test('formatLocalTime returns HH:MM in local time', () => {
	const result = apiMessages.formatLocalTime('2026-03-28T20:03:39.833Z')
	// Should be a HH:MM string (exact value depends on system timezone)
	expect(result).toMatch(/^\d{2}:\d{2}$/)
})

test('formatLocalTime returns null for missing/invalid input', () => {
	expect(apiMessages.formatLocalTime(undefined)).toBeNull()
	expect(apiMessages.formatLocalTime('')).toBeNull()
	expect(apiMessages.formatLocalTime('not-a-date')).toBeNull()
})

test('pruneMessages batches heavy pruning by completed turns', () => {
	const prev = {
		heavyThreshold: apiMessages.config.heavyThreshold,
		thinkingThreshold: apiMessages.config.thinkingThreshold,
		pruneBatchTurns: apiMessages.config.pruneBatchTurns,
	}
	apiMessages.config.heavyThreshold = 0
	apiMessages.config.thinkingThreshold = 99
	apiMessages.config.pruneBatchTurns = 2
	try {
		const beforeBatch: Message[] = [
			{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'a.ts' } }] },
			{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'alpha' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'done' }] },
		]
		const afterBatch: Message[] = [
			...beforeBatch,
			{ role: 'user', content: 'next' },
			{ role: 'assistant', content: [{ type: 'text', text: 'done again' }] },
		]
		expect(apiMessages.pruneMessages(beforeBatch)).toEqual(beforeBatch)
		expect(apiMessages.pruneMessages(afterBatch)).toEqual([
			{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: {} }] },
			{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '[tool result omitted from context]' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'done' }] },
			{ role: 'user', content: 'next' },
			{ role: 'assistant', content: [{ type: 'text', text: 'done again' }] },
		])
	} finally {
		apiMessages.config.heavyThreshold = prev.heavyThreshold
		apiMessages.config.thinkingThreshold = prev.thinkingThreshold
		apiMessages.config.pruneBatchTurns = prev.pruneBatchTurns
	}
})

test('pruneMessages batches thinking pruning too', () => {
	const prev = {
		heavyThreshold: apiMessages.config.heavyThreshold,
		thinkingThreshold: apiMessages.config.thinkingThreshold,
		pruneBatchTurns: apiMessages.config.pruneBatchTurns,
	}
	apiMessages.config.heavyThreshold = 99
	apiMessages.config.thinkingThreshold = 0
	apiMessages.config.pruneBatchTurns = 2
	try {
		const beforeBatch: Message[] = [
			{ role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 'sig' }, { type: 'text', text: 'answer' }] },
		]
		const afterBatch: Message[] = [
			...beforeBatch,
			{ role: 'user', content: 'next' },
			{ role: 'assistant', content: [{ type: 'text', text: 'done' }] },
			{ role: 'user', content: 'next 2' },
			{ role: 'assistant', content: [{ type: 'text', text: 'done 2' }] },
		]
		expect(apiMessages.pruneMessages(beforeBatch)).toEqual(beforeBatch)
		expect(apiMessages.pruneMessages(afterBatch)).toEqual([
			{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
			{ role: 'user', content: 'next' },
			{ role: 'assistant', content: [{ type: 'text', text: 'done' }] },
			{ role: 'user', content: 'next 2' },
			{ role: 'assistant', content: [{ type: 'text', text: 'done 2' }] },
		])
	} finally {
		apiMessages.config.heavyThreshold = prev.heavyThreshold
		apiMessages.config.thinkingThreshold = prev.thinkingThreshold
		apiMessages.config.pruneBatchTurns = prev.pruneBatchTurns
	}
})

